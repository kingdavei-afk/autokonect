import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  sql,
  type Database,
  type Db,
  type Transaction,
  type ProviderType,
  type SqlBool,
} from '@adkcars/database';
import {
  allowedTransitionsForActor,
  assertPlausibleDuration,
  buildPagination,
  computePricing,
  OCCUPYING_STATUSES,
  TransitionNotAllowedError,
  type BookingDetail,
  type BookingFilterInput,
  type BookingStatus,
  type BookingSummary,
  type CancelBookingInput,
  type CreateBookingInput,
  type Pagination,
  type TransitionBookingInput,
  assertTransition,
  canTransition,
  cents,
  type Centimes,
} from '@adkcars/contracts';

import { DATABASE } from '../../common/tokens';
import type { AuthenticatedUser } from '../auth/auth.guards';
import { accessFor, actorOf, canActOn, canView, toDetail, toSummary } from './booking.mapper';
import type {
  BookingHistoryRow,
  BookingJoinedRow,
  BookingRow,
  CommissionCandidateRow,
  ResolvedCommission,
} from './booking.types';

/** Alphabet de la reference courte : sans ambiguite visuelle. */
const REFERENCE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY3479';

/**
 * Duree de validite d'une reservation en attente de paiement.
 *
 * Au-dela, la reservation expire et le vehicule se libere. Sans delai,
 * un panier abandonne immobiliserait un vehicule indefiniment — c'est la
 * panne qui rend un marche inexploitable pour ses fournisseurs.
 */
const AWAITING_PAYMENT_TTL_MINUTES = 30;

/**
 * Metier de la reservation (CDCS 8).
 *
 * ------------------------------------------------------------------------
 * OU SONT LES REGLES, ET POURQUOI
 * ------------------------------------------------------------------------
 * Le CDCS 8.1 impose quatre invariants. Ils sont répartis entre trois
 * couches, chacune à l'endroit où elle est la plus difficile à contourner :
 *
 * | Invariant                                        | Couche         |
 * |--------------------------------------------------|----------------|
 * | 1. Vehicule indisponible pendant la location       | base (trigger) |
 * | 2. Transition non autorisee refusee (409)          | ici + contrats |
 * | 3. Chaque transition ecrit une ligne d'audit       | ici            |
 * | 4. Aucun etat modifiable manuellement en base      | base + procedure |
 *
 * Le declencheur `prevent_booking_overlap` applique l'invariant 1, et il
 * est le SEUL endroit où la concurrence est traitee de façon atomique.
 * Deux requêtes concurrentes passent toutes deux le contrôle applicatif ;
 * une seule aboutit. C'est pourquoi ce contrôle est une commodité et
 * non une garantie : il rend les refus explicites, la base les rend
 * impossibles à contourner.
 */
@Injectable()
export class BookingService {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  // ==================================================================
  // Creation
  // ==================================================================

  /**
   * Cree une reservation a l'etat `awaiting_payment`.
   *
   * La reservation N'EST PAS creee en `draft` : le `draft` sert au panier
   * cote client. Toute reservation enregistree occupe deja le vehicule,
   * et la dire `draft` rendrait l'occupation invisible dans les
   * statistiques sans etre reelle.
   */
  async create(
    input: CreateBookingInput,
    actor: AuthenticatedUser,
  ): Promise<BookingDetail> {
    if (actor.roles.includes('admin')) {
      throw new ForbiddenException({
        code: 'ADMIN_CANNOT_BOOK',
        message:
          "Un administrateur ne reserve pas pour lui. Utilisez le compte client " +
          "correspondant pour effectuer une reservation.",
      });
    }

    // Une saisie aberrante est une ERREUR DU CLIENT, pas une panne. La
    // fonction partagee leve une `Error` ordinaire ; sans conversion
    // ici, le filtre global en ferait un 500, et le client verrait
    // « erreur interne » pour une simple date mal saisie — ce qui
    // l'empeche de comprendre quoi corriger.
    try {
      assertPlausibleDuration(input.startAt, input.endAt);
    } catch (error) {
      throw new UnprocessableEntityException({
        code: 'DUREE_IMPLAUSIBLE',
        message: (error as Error).message,
      });
    }

    const vehicle = await this.loadBookableVehicle(input.vehicleId);
    const commission = await this.resolveCommission(vehicle.providerType, vehicle.agencyId, vehicle.ownerId);

    // Le prix est calcule par la fonction PARTAGEE, jamais recalcule
    // ici : c'est ce qui garantit que l'application mobile affiche le
    // meme montant que la facture (CDCS 7.5).
    let pricing;
    try {
      pricing = computePricing({
        dailyRate: cents(vehicle.dailyRate),
        depositAmount: cents(vehicle.depositAmount),
        startAt: input.startAt,
        endAt: input.endAt,
      });
    } catch (error) {
      throw new UnprocessableEntityException({
        code: 'PRICING_NOT_POSSIBLE',
        message: (error as Error).message,
      });
    }

    await this.assertNoAvailabilityBlock(vehicle.id, input.startAt, input.endAt);

    const reference = await this.newReference();

    // Le tableau de prix est FIGE ici. Il ne sera plus recalcule : une
    // facture presentee au client ne bouge pas, meme si le tarif du
    // vehicule change le lendemain.
    const snapshot = {
      version: 1,
      billedDays: pricing.billedDays,
      durationMs: pricing.durationMs,
      rentalAmount: pricing.rentalAmount.toString(),
      depositAmount: pricing.depositAmount.toString(),
      totalAmount: pricing.totalAmount.toString(),
      dailyRateAtCreation: vehicle.dailyRate,
      lines: pricing.lines.map((line) => ({
        label: line.label,
        quantity: line.quantity,
        unitAmount: line.unitAmount.toString(),
        amount: line.amount.toString(),
      })),
      commissionRate: commission.rate,
      commissionSource: commission.source,
      computedAt: new Date().toISOString(),
    };

    const row = await this.insertBooking({
      reference,
      clientId: actor.id,
      vehicle,
      input,
      pricing,
      commission,
      snapshot,
    });

    return this.detail(row.id, actor);
  }

  private async insertBooking(args: {
    reference: string;
    clientId: string;
    vehicle: BookableVehicle;
    input: CreateBookingInput;
    pricing: ReturnType<typeof computePricing>;
    commission: ResolvedCommission;
    snapshot: Record<string, unknown>;
  }): Promise<BookingRow> {
    const { reference, clientId, vehicle, input, pricing, commission, snapshot } = args;

    try {
      const inserted = await sql<BookingRow>`
        INSERT INTO booking (
          reference, client_id, provider_type, agency_id, owner_id, vehicle_id,
          start_at, end_at, pickup_location_id, return_location_id, is_one_way,
          status, pricing_snapshot, currency_code, total_amount, deposit_amount,
          commission_rate, commission_source, customer_notes
        )
        VALUES (
          ${reference}, ${clientId}, ${vehicle.providerType}, ${vehicle.agencyId},
          ${vehicle.ownerId}, ${vehicle.id},
          ${input.startAt}, ${input.endAt},
          ${input.pickupLocationId ?? null}, ${input.returnLocationId ?? null},
          ${input.isOneWay}, 'awaiting_payment', ${JSON.stringify(snapshot)}::jsonb,
          ${vehicle.currencyCode}, ${pricing.totalAmount}, ${pricing.depositAmount},
          ${commission.rate}, ${commission.source}, ${input.customerNotes ?? null}
        )
        RETURNING *
      `.execute(this.db);

      const row = inserted.rows[0];

      if (!row) {
        throw new InternalServerErrorException('Insertion silencieuse sans ligne retournee.');
      }

      // Invariant 3 (CDCS 8.1) : meme la creation est tracee, avec un
      // etat source nul. Une reservation apparue sans trace d origine
      // serait inexpliquable en cas de litige.
      await this.writeHistory(row.id, null, 'awaiting_payment', clientId, 'Reservation creee');

      return row;
    } catch (error) {
      throw this.translate(error);
    }
  }

  // ==================================================================
  // Lecture
  // ==================================================================

  async list(filter: BookingFilterInput, actor: AuthenticatedUser): Promise<{
    items: BookingSummary[];
    pagination: Pagination;
  }> {
    const isAdmin = actor.roles.includes('admin');
    const page = filter.page ?? 1;
    const perPage = filter.perPage ?? 20;

    const scope = sql<{ id: string }>`
      SELECT b.id
      FROM booking b
      WHERE (${isAdmin} OR b.client_id = ${actor.id} OR b.agency_id = ${actor.id} OR b.owner_id = ${actor.id})
        AND (${filter.status ?? null}::text IS NULL OR b.status = ${filter.status ?? null})
        AND (${filter.vehicleId ?? null}::uuid IS NULL OR b.vehicle_id = ${filter.vehicleId ?? null})
        AND (
          ${filter.when ?? null}::text IS NULL
          OR (${filter.when} = 'upcoming' AND b.end_at > now())
          OR (${filter.when} = 'current' AND b.start_at <= now() AND b.end_at > now())
          OR (${filter.when} = 'past'    AND b.end_at <= now())
        )
      ORDER BY b.created_at DESC
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `;

    const count = sql<{ total: string }>`
      SELECT count(*)::text AS total
      FROM booking b
      WHERE (${isAdmin} OR b.client_id = ${actor.id} OR b.agency_id = ${actor.id} OR b.owner_id = ${actor.id})
        AND (${filter.status ?? null}::text IS NULL OR b.status = ${filter.status ?? null})
    `;

    const [items, total] = await Promise.all([scope.execute(this.db), count.execute(this.db)]);

    if (items.rows.length === 0) {
      return { items: [], pagination: buildPagination(page, perPage, 0) };
    }

    const joined = await this.joinVehicles(items.rows.map((r) => r.id));

    return {
      items: joined.map(toSummary),
      pagination: buildPagination(page, perPage, Number(total.rows[0]?.total ?? 0)),
    };
  }

  async detail(id: string, actor: AuthenticatedUser): Promise<BookingDetail> {
    const rows = await this.joinVehicles([id]);
    const row = rows[0];

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const access = accessFor(row, actor.id, actor.roles.includes('admin'));

    if (!canView(access)) {
      // 404 et non 403 : repondre « interdit » confirme l existence de
      // la reservation. Un concurrent pourrait alors enumerer les
      // reservations des autres par sondage d'identifiants.
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const history = await this.loadHistory(id);

    return toDetail(row, allowedTransitionsForActor(row.status, actorOf(access)), history);
  }

  /**
   * Disponibilite d'un vehicule sur une plage donnee.
   *
   * Distincte de la liste des reservations : elle repond a « puis-je
   * reserver ces dates » sans exposer les reservations des autres. Une
   * absence de date disponible doit dire POURQUOI — le vehicule est
   * bloque, en maintenance, ou deja reserve.
   */
  async availability(
    vehicleId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<{ available: boolean; reason: 'free' | 'blocked' | 'maintenance' | 'booked' }> {
    const blocking = await sql<{ type: string }>`
      SELECT type FROM availability
      WHERE vehicle_id = ${vehicleId}
        AND type IN ('blocked', 'maintenance')
        AND start_at < ${endAt} AND ${startAt} < end_at
      LIMIT 1
    `.execute(this.db);

    const declared = blocking.rows[0]?.type;
    if (declared === 'blocked') return { available: false, reason: 'blocked' };
    if (declared === 'maintenance') return { available: false, reason: 'maintenance' };

    const occupied = await sql<{ id: string }>`
      SELECT id FROM booking
      WHERE vehicle_id = ${vehicleId}
        AND status IN (${sql.join(OCCUPYING_STATUSES.map((s) => sql`${s}`))})
        AND start_at < ${endAt} AND ${startAt} < end_at
      LIMIT 1
    `.execute(this.db);

    return occupied.rows.length > 0
      ? { available: false, reason: 'booked' }
      : { available: true, reason: 'free' };
  }

  // ==================================================================
  // Transitions
  // ==================================================================

  async transition(
    id: string,
    input: TransitionBookingInput,
    actor: AuthenticatedUser,
  ): Promise<BookingDetail> {
    const row = await this.rawBooking(id);

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const access = accessFor(row, actor.id, actor.roles.includes('admin'));

    if (!canActOn(access)) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const actorRole = actorOf(access);
    const permitted = allowedTransitionsForActor(row.status, actorRole);

    // Invariant 2 (CDCS 8.1). Le message liste les transitions possibles :
    // un client qui recoit « 409 » sans plus d'information ne peut rien
    // faire de son erreur.
    if (!canTransition(row.status, input.to) || !permitted.includes(input.to)) {
      throw new ConflictException({
        code: 'TRANSITION_NON_AUTORISEE',
        message:
          `Transition non autorisee : ${row.status} -> ${input.to}.`,
        // Le detail est un CONTRAT, pas une fuite interne : sans la liste
        // des transitions possibles, le client recoit un « 409 » et ne
        // peut rien faire de son erreur. Il ne doit contenir que des
        // etats et des versions, jamais de detail technique.
        details: { from: row.status, to: input.to, actor: actorRole, allowed: permitted },
      });
    }

    return this.applyTransition(row, input.to, actor, input.reason, input.expectedVersion);
  }

  /**
   * Annulation.
   *
   * Voie dediee plutot qu'une transition generique : l'annulation porte
   * des effets financiers — restitution, penalite, Liberation du
   * vehicule — qui doivent etre explicites et non derives du seul etat
   * cible. `by` est declare par l'appelant, puis **recoupe** avec son
   * role reel : un client ne peut pas annuler en se faisant passer pour
   * le fournisseur.
   */
  async cancel(
    id: string,
    input: CancelBookingInput,
    actor: AuthenticatedUser,
  ): Promise<BookingDetail> {
    const row = await this.rawBooking(id);

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const access = accessFor(row, actor.id, actor.roles.includes('admin'));

    if (!canActOn(access)) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    if (input.by === 'client' && access.provider) {
      throw new ForbiddenException({
        code: 'ACTOR_MISMATCH',
        message:
          "Vous etes le fournisseur de cette reservation : l'annulation ne peut " +
          "pas etre enregistree comme coming du client.",
      });
    }

    const target: BookingStatus =
      input.by === 'client' ? 'cancelled_client' : 'cancelled_provider';

    if (!canTransition(row.status, target)) {
      throw new ConflictException({
        code: 'TRANSITION_NON_AUTORISEE',
        message: `Annulation impossible depuis l'etat ${row.status}.`,
        details: {
          from: row.status,
          to: target,
          allowed: allowedTransitionsForActor(row.status, actorOf(access)),
        },
      });
    }

    // Le reglement financier est calcule AVANT la transition, pour qu il
    // soit ecrit dans la meme transaction que l annulation. L inverse
    // laisserait une reservation annulee sans sanction appliquee, si
    // l ecriture du reglement echouait apres coup.
    await this.settleCancellation(row.id, input.by);

    return this.applyTransition(row, target, actor, input.reason, input.expectedVersion);
  }

  /**
   * Depassement de restitution (CDCS 4.6, A-21).
   *
   * 30 minutes de grace, puis chaque heure COMMENCEE a 50 % du tarif
   * journalier. La regle est FIGEE dans `policy_snapshot` a la creation ;
   * la fonction de la base l'applique telle quelle.
   *
   * Le montant est ensuite ecrit dans `overtime_amount`, qui n'est pas
   * recalculable. C'est ce qui le rend contestable : un montant reclamable
   * au client qui change selon l'heure de la question ne peut pas etre
   * conteste.
   *
   * Une restitution A L HEURE donne zero, ce qui est ecrit. Un zero pose
   * vaut mieux que NULL : il distingue « pas de depassement constate » de
   * « depassement jamais calcule », et le second doit se voir.
   *
   * Aucun montant n est preleve ICI. A-04 (capture de la caution) n'est
   * pas arbitre et la caution n'est pas encaissee : le recouvrement du
   * depassement attendra son circuit.
   */
  private async settleOvertime(
    bookingId: string,
    returnedAt: Date | null,
    trx: Transaction<Database>,
  ): Promise<void> {
    const [issue] = await trx
      .selectFrom(
        sql<{
          grace_minutes: number;
          overage_hours: number;
          daily_rate: string;
          overage_amount: string;
        }>`booking_overtime(${bookingId}, ${returnedAt})`.as('issue'),
      )
      .selectAll()
      .execute();

    // Comme pour le reglement d annulation : la fonction retourne une
    // ligne ou leve. Le type ne le dit pas, et le code ne doit pas le
    // presumer.
    if (!issue) {
      throw new ConflictException({
        code: 'OVERTIME_UNAVAILABLE',
        message:
          'Le depassement de restitution n a pas pu etre calcule. Traitement manuel requis.',
        details: { bookingId },
      });
    }

    await trx
      .updateTable('booking')
      .set({ overtime_amount: issue.overage_amount })
      .where('id', '=', bookingId)
      .execute();
  }

  /**
   * Reglement financier d'une annulation (CDCS 4.6, A-21).
   *
   * Appele AVANT la transition, dans la meme transaction. L'ordre est
   * impose par la migration 0007 : `policy_snapshot` est fige a la
   * creation et ne se reecrit pas, donc il doit etre present quand la
   * sanction est calculee.
   *
   * ------------------------------------------------------------------------
   * LE DEVIS ET LA COLLECTE NE COINCIDENT PAS
   * ------------------------------------------------------------------------
   * `booking_financial_outcome` calcule sur le devis FIGE : tarif de
   * location, caution ANNONCEE, taux de sanction. Le devis porte ce que
   * le client a ACCEPTE.
   *
   * Ce qui a ete ENCAISSE n'est pas le devis. A-04 (capture de la
   * caution) n'etant pas arbitre, la caution n'est pas collectee. Un
   * remboursement calcule sur le devis rendrait donc de l'argent que
   * personne n'a jamais donne.
   *
   * Chaque montant est donc borne par la collecte reelle, et le
   * remboursement porte sur le PAIEMENT qui a encaisse — pas sur un
   * total theorique.
   *
   * ------------------------------------------------------------------------
   * RIEN ENCAISSE, RIEN A REGLEMENT
   * ------------------------------------------------------------------------
   * Une reservation annulee avant paiement ne produit NI sanction NI
   * remboursement. On ne reclame pas une penalite a quelqu'un qui n'a
   * rien verse, et un remboursement de zero serait un enregistrement
   * sans objet : il polluerait le journal des remboursements sans rien
   * dire sur l'argent.
   */
  private async settleCancellation(
    bookingId: string,
    annulePar: 'client' | 'provider',
  ): Promise<void> {
    const paiements: Array<{
      id: string;
      amount: string;
      currency_code: string;
      kind: string;
    }> = await this.db
      .selectFrom('payment')
      .select(['id', 'amount', 'currency_code', 'kind'])
      .where('booking_id', '=', bookingId)
      .where('status', '=', 'paid')
      .execute();

    const encaisse = paiements.reduce(
      (total: bigint, paiement) => total + BigInt(paiement.amount as string),
      0n,
    );

    if (encaisse === 0n) {
      // Aucune trace financiere : rien n'a bouge, donc rien a constater.
      return;
    }

    // La fonction de la base applique la politique FIGEE : delai
    // gratuit, taux de sanction, confiscation de la caution en cas de
    // non-presentation. Elle refuse de calculer si la politique est
    // absente — ce qui est le comportement voulu plutot qu'un defaut par
    // defaut applique apres coup.
    const [issue] = await this.db
      .selectFrom(
        sql<{
          basis: string;
          penalty_amount: string;
          deposit_forfeited: string;
        }>`booking_financial_outcome(${bookingId}, now())`.as('issue'),
      )
      .selectAll()
      .execute();

    // La sanction est plafonnee a la COLLECTE, pas au devis. C'est la
    // seule borne qui ait un sens tant que la caution n'est pas
    // encaissee : prelever 90 000 sur une collecte de 180 000 est
    // possible, prelever 90 000 sur une collecte de 0 ne l'est pas.
    // La fonction retourne TOUJOURS une ligne, ou leve. Le type ne le
    // dit pas, et le code ne doit pas le présumer.
    //
    // Traiter `issue` comme présent sans le vérifier serait une
    // assertion silencieuse : si la fonction change un jour pour renvoyer
    // zéro ligne, le service construirait `BigInt(undefined)` — une
    // exception opaque, loin de sa cause.
    if (!issue) {
      throw new ConflictException({
        code: 'FINANCIAL_OUTCOME_UNAVAILABLE',
        message:
          'Le reglement financier de cette annulation n a pas pu etre calcule. Traitement manuel requis.',
        details: { bookingId },
      });
    }

    const sanction = BigInt(issue.penalty_amount);
    const cautionRetenue = BigInt(issue.deposit_forfeited);

    const sanctionEffective = sanction > encaisse ? encaisse : sanction;
    const cautionEffective = cautionRetenue > encaisse ? encaisse : cautionRetenue;

    const retenue = sanctionEffective + cautionEffective;

    // Les colonnes sont figees (migration 0007) : on les ecrit UNE FOIS,
    // a l'annulation. C'est ce qui rend la sanction verifiable a
    // posteriori — un montant recalcule au moment du rapport pourrait
    // differer de celui qui a ete prononce.
    await this.db
      .updateTable('booking')
      .set({
        cancellation_penalty_amount: sanctionEffective.toString(),
        forfeited_deposit_amount: cautionEffective.toString(),
      })
      .where('id', '=', bookingId)
      .execute();

    if (retenue === 0n) {
      // Annulation dans le delai gratuit : la sanction est nulle, mais
      // l'argent collecte doit etre rendu. L'enregistrement existe malgre
      // tout — c est lui qui dit au client ce qui va lui etre rendu.
    }

    const restant = encaisse - retenue;

    if (restant > 0n) {
      // Le remboursement est porte par le paiement qui a encaisse, et
      // non par un total theorique. Plusieurs paiements pour une meme
      // reservation sont normaux — un client qui echoue puis reessaye —
      // et repartir le restant entre eux donnerait des fractions
      // inexploitables au prestataire.
      // Le type est DERIVE de la selection ci-dessus, pas reecrit. Un
      // type declare a la main finit par diverger de la requete au
      // prochain changement de colonne — et c'est ainsi qu'on lit un
      // `undefined` en production sans avoir rien change.
      type PaiementSelectionne = (typeof paiements)[number];

      const principal: PaiementSelectionne = paiements.reduce(
        (meilleur, candidat) =>
          BigInt(candidat.amount as string) > BigInt(meilleur.amount as string)
            ? candidat
            : meilleur,
      );

      await this.db
        .insertInto('refund')
        .values({
          payment_id: principal.id,
          kind: cautionEffective > 0n ? 'deposit_capture' : 'refund',
          amount: restant.toString(),
          currency_code: principal.currency_code as string,
          status: 'pending',
          reason: annulePar === 'client'
            ? 'Annulation du client'
            : 'Annulation du fournisseur',
        })
        .execute();
    }
  }

  /**
   * Applique une transition : verrouille la ligne, verifie la version,
   * ecrit l'etat et l'audit dans UNE transaction.
   *
   * ------------------------------------------------------------------------
   * LE VERROU OPTIMISTE EST CE QUI EMPECHE LA COURSE
   * ------------------------------------------------------------------------
   * Deux agents lisent la reservation, tous deux voient « payee », tous
   * deux demandent une transition differente. Sans controle de version,
   * la seconde ecriture ecrase la premiere : une annulation disparait
   * silencieusement, ou un vehicule est declare « en cours » sur une
   * reservation annulee.
   *
   * `WHERE version = $attendue` fait que la seconde requete ne modifie
   * ZERO ligne. Aucune fenetre, aucune ecriture partielle, aucun
   * verrou long a maintenir.
   */
  /**
   * Detail d une reservation, sans controle d acces.
   *
   * Reserve aux actions systemes dont l autorisation a deja ete verifiee
   * — ou n avait pas lieu d'etre, faute d'appelant.
   *
   * Volontairement SANS controle. C'est ce qui distingue cette methode de
   * `detail`, et la difference doit rester visible : une methode de
   * lecture sans controle d'acces est une fuite si elle est appelee par
   * une route.
   */
  private async detailForSystem(id: string): Promise<BookingDetail> {
    const rows = await this.joinVehicles([id]);
    const row = rows[0];

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const history = await this.loadHistory(id);

    // Toutes les transitions sont proposees : il n'y a pas d'appelant
    // dont le role restreigne le choix. La reservation vient de passer a
    // `paid`, et le paiement decide de la suite.
    return toDetail(row, allowedTransitionsForActor(row.status, 'client'), history);
  }

  /** Confirmation de paiement — point d'entree SYSTEME, sans utilisateur.
   *
   * Reservee au module Paiement, sur confirmation d'un encaissement par
   * le prestataire. Volontairement etroite : elle ne fait qu'une chose.
   *
   * Elle n'exige pas d'acteur, et c'est deliberé. Un webhook est appele
   * par un prestataire, pas par une personne. Lui fabriquer un acteur
   * fictif lui donnerait les pouvoirs d'un administrateur — donc la
   * possibilite d'annuler une reservation ou de l'ouvrir a un litige sur
   * la seule foi d'une signature. Le niveau d'autorisation d'un webhook
   * doit rester etroit, meme quand sa source est fiable.
   *
   * Le verrou de version est conserve : une annulation concurrente
   * declenche `VERSION_CONFLIT` plutot que d'etre ecrasee. C'est
   * exactement la course qu'il faut laisser remonter au paiement, qui
   * saura alors ne pas encaisser.
   *
   * ORDRE IMPOSE : la reservation passe `paid` AVANT que le paiement
   * ne soit marque `paid`. La migration 0008 refuse un encaissement sur
   * une reservation annulee ; cette methode doit donc s'executer en
   * premier, dans la meme transaction.
   */
  async confirmPaidByPayment(bookingId: string, expectedVersion: number): Promise<BookingDetail> {
    const row = await this.rawBooking(bookingId);

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    // Le seul etat depuis lequel un encaissement a du sens. Une
    // reservation deja paye, annulee ou terminee ne se re-confirme pas :
    // c'est le paiement qui doit etre examine, pas la reservation.
    if (row.status !== 'awaiting_payment') {
      throw new ConflictException({
        code: 'BOOKING_NOT_AWAITING_PAYMENT',
        message: `La reservation est au statut ${row.status} et ne peut pas etre confirmee par un paiement.`,
        details: { status: row.status, expected: 'awaiting_payment' },
      });
    }

    // Acteur systeme minimal : pas de courriel, pas de telephone. Ces
    // champs n'existent pas dans `AuthenticatedUser` — un acteur
    // systeme n'est pas un utilisateur, et lui en attribuer un
    // enregistrerait dans l'audit une adresse qui n'appartient a
    // personne.
    // Aucun acteur. Une confirmation de paiement n'est portee par
    // personne : elle est constatee. Fabriquer un identifiant aurait
    // inscription dans l'audit un utilisateur inexistant.
    return this.applyTransition(
      row,
      'paid',
      null as unknown as AuthenticatedUser,
      undefined,
      expectedVersion,
      'Paiement confirme par le prestataire',
    );
  }

  private async applyTransition(
    row: BookingRow,
    to: BookingStatus,
    actor: AuthenticatedUser,
      reason: string | undefined,
      expectedVersion: number,
      /**
       * Origine systeme de la transition, quand elle n est portee
       * par personne.
       *
       * Renseignee pour une expiration automatique ou une confirmation
       * par un prestataire. Deux effets, tous deux voulus :
       *
       *   * `booking_status_history.actor_id` est mis a `NULL`. La colonne
       *     est nullable precisement pour ces cas ; y inscrire un
       *     identifiant fabrique donnerait a l audit un utilisateur qui
       *     n existe pas — un mensonge qui passe parce qu il a la bonne
       *     forme.
       *   * le controle d acces du retour est ignore : une action
       *     systeme n a pas d appelant, donc personne a autoriser.
       *
       * Explicite plutot que deduit d un acteur nul : un `actor` nul
       * passe par accident ne produirait pas ce comportement.
       */
      systemReason: string | undefined = undefined,
  ): Promise<BookingDetail> {
    if (row.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLIT',
        message:
          'La reservation a change depuis votre lecture. Rechargez et reessayez.',
        // La version courante permet au client de rejouer sa demande
        // sans aller relire la reservation a la main.
        details: { currentVersion: row.version, expectedVersion },
      });
    }

    const now = new Date();

    // Les horodatages de passage sont poses UNE FOIS POUR LE TOUT : une
    // transition ne doit pas effacer les precedents. Une reservation
    // annulee apres avoir ete demarree conserve donc ses deux marques.
    const isCancelled = to.startsWith('cancelled');
    const isEnding = to === 'completed' || to === 'late_return' || to === 'disputed';

    const confirmedAt = to === 'paid' ? now : row.confirmed_at;
    const startedAt = to === 'in_progress' ? now : row.started_at;
    const endedAt = isEnding ? now : row.ended_at;
    const cancelledAt = isCancelled ? now : row.cancelled_at;
    const cancelReason = isCancelled ? (reason ?? null) : row.cancel_reason;

    try {
      await this.db.transaction().execute(async (trx) => {
        const updated = await sql<{ id: string }>`
          UPDATE booking
          SET status = ${to},
              version = version + 1,
              confirmed_at = ${confirmedAt},
              started_at = ${startedAt},
              ended_at = ${endedAt},
              cancelled_at = ${cancelledAt},
              cancel_reason = ${cancelReason}
          WHERE id = ${row.id}
            AND version = ${expectedVersion}
          RETURNING id
        `.execute(trx);

        // Zero ligne : la version a change entre la lecture et l'ecriture.
        // La transaction est alors annulee, sans trace partielle.
        if (updated.rows.length === 0) {
          throw new ConflictException({
            code: 'VERSION_CONFLIT',
            message:
              'La reservation a ete modifiee de façon concurrente. Rechargez et reessayez.',
            details: { expectedVersion },
          });
        }

        // Le depassement de restitution est pose DANS la meme
        // transaction, juste apres `ended_at`.
        //
        // `ended_at` est l ENTREE du calcul : hors transaction, un autre
        // processus pourrait modifier la reservation entre le calcul et
        // l ecriture, et le montant fige ne correspondrait plus a ce
        // qu il calcule.
        //
        // Calcule pour les TROIS etats de fin : un depassement est un fait
        // sur le temps, pas une consequence du statut declare. Un vehicule
        // rendu en retard peut etre enregistre `completed` — le client qui
        // dit « c est fini » ne decide pas du retard.
        if (isEnding) {
          await this.settleOvertime(row.id, endedAt, trx);
        }

        // Invariant 3 (CDCS 8.1) : l'audit est ecrit DANS LA MEME
        // TRANSACTION que l'etat. Un audit ecrit apres le commit
        // pourrait disparaitre sur un echec, et il ne resterait alors
        // qu'un changement d'etat inexplique.
        await sql`
          INSERT INTO booking_status_history (booking_id, from_status, to_status, actor_id, reason)
            VALUES (
              ${row.id},
              ${row.status},
              ${to},
              ${systemReason ? null : actor.id},
              ${systemReason ?? reason ?? null}
            )
        `.execute(trx);
      });
    } catch (error) {
      throw this.translate(error);
    }

      // Une action systeme n a pas d appelant : repasser par
      // `detail` ferait echouer le controle d acces, qui compare
      // l acteur a la reservation. L autorisation a deja ete
      // verifiee — ou n avait pas lieu d etre, faute d appelant.
      return systemReason
        ? await this.detailForSystem(row.id)
        : this.detail(row.id, actor);
  }

  // ==================================================================
  // Regles annexes
  // ==================================================================

  /**
   * Expire les reservations en attente de paiement dont le delai est
   * depasse (CDCS 8.1).
   *
   * Le verrou SANS SKIP LOCKED est indispensable : le traitement tourne
   * periodiquement, et deux executions ne doivent pas exiger la meme
   * ligne — la seconde attendrait indefiniment la premiere.
   */
  async expireStaleAwaitingPayment(): Promise<number> {
    const cutoff = new Date(Date.now() - AWAITING_PAYMENT_TTL_MINUTES * 60_000);

    const result = await this.db.transaction().execute(async (trx) => {
      const claimed = await sql<{ id: string; previous_status: string }>`
        UPDATE booking
        SET status = 'expired', version = version + 1
        WHERE id IN (
          SELECT id FROM booking
          WHERE status = 'awaiting_payment'
            AND created_at < ${cutoff}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, 'awaiting_payment'::text AS previous_status
      `.execute(trx);

      if (claimed.rows.length === 0) return 0;

      const ids = claimed.rows.map((r) => r.id);

      await sql`
        INSERT INTO booking_status_history (booking_id, from_status, to_status, reason)
        SELECT unnest(${ids}::uuid[]), 'awaiting_payment', 'expired',
               'Delai de paiement depasse'
      `.execute(trx);

      return claimed.rows.length;
    });

    return result;
  }

  // ==================================================================
  // Acces aux donnees
  // ==================================================================

  private async rawBooking(id: string): Promise<BookingRow | undefined> {
    const result = await sql<BookingRow>`SELECT * FROM booking WHERE id = ${id} LIMIT 1`
      .execute(this.db);
    return result.rows[0];
  }

  private async loadHistory(bookingId: string): Promise<BookingHistoryRow[]> {
    const result = await sql<BookingHistoryRow>`
      SELECT id, from_status, to_status, actor_id, reason, at
      FROM booking_status_history
      WHERE booking_id = ${bookingId}
      ORDER BY at DESC
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Complete des reservations par vehicule et contrepartie.
   *
   * Deux requetes et non une jointure qui ramene toutes les colonnes :
   * la liste demande peu de donnees, le detail en demande plus. La
   * liste de colonnes explicite evite aussi de renvoyer par megarde une
   * colonne sensible dans une charge utile.
   */
  private async joinVehicles(ids: string[]): Promise<BookingJoinedRow[]> {
    if (ids.length === 0) return [];

    const result = await sql<BookingJoinedRow>`
      SELECT b.*,
             v.brand      AS v_brand,
             v.model      AS v_model,
             v.plate_number AS v_plate_number,
             v.daily_rate AS v_daily_rate,
             v.deposit_amount AS v_deposit_amount,
             COALESCE(a.name, o.email, o.phone, 'Partenaire') AS cp_name,
             b.provider_type AS cp_type
      FROM booking b
      JOIN vehicle v ON v.id = b.vehicle_id
      LEFT JOIN agency a ON a.id = b.agency_id
      LEFT JOIN "user" o ON o.id = b.owner_id
      WHERE b.id IN (${sql.join(ids.map((id) => sql`${id}`))})
    `.execute(this.db);

    const order = new Map(ids.map((id, index) => [id, index]));
    return result.rows.sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  }

  // ==================================================================
  // Regles de creation
  // ==================================================================

  /**
   * Charge un vehicule reservationsable.
   *
   * Seul un vehicule PUBLIE est reservable. Reserver un brouillon
   * signifierait faire payer un client pour un vehicule dont les
   * documents ne sont pas verifies — le controle a ete fait, mais par
   * une autre voie.
   */
  private async loadBookableVehicle(vehicleId: string): Promise<BookableVehicle> {
    const result = await sql<{
      id: string;
      provider_type: ProviderType;
      agency_id: string | null;
      owner_id: string | null;
      status: string;
      daily_rate: string;
      deposit_amount: string;
      currency_code: string;
    }>`
      SELECT id, provider_type, agency_id, owner_id, status,
             daily_rate, deposit_amount, 'XOF'::char(3) AS currency_code
      FROM vehicle
      WHERE id = ${vehicleId}
      LIMIT 1
    `.execute(this.db);

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException({
        code: 'VEHICLE_NOT_FOUND',
        message: 'Vehicule introuvable.',
      });
    }

    if (row.status !== 'published') {
      throw new ConflictException({
        code: 'VEHICLE_NOT_PUBLISHED',
        message:
          'Ce vehicule n est pas encore disponible a la reservation : il est en cours ' +
          'de validation.',
      });
    }

    return {
      id: row.id,
      providerType: row.provider_type,
      agencyId: row.agency_id,
      ownerId: row.owner_id,
      dailyRate: row.daily_rate,
      depositAmount: row.deposit_amount,
      currencyCode: row.currency_code,
    };
  }

  /**
   * Refuse une plage bloquee ou en maintenance (CDCS 8.6).
   *
   * Le declencheur anti-chevauchement ne couvre QUE les reservations. Un
   * blocage declare par le fournisseur doit etre verifie ici, sinon un
   * vehicule envoye en maintenance resterait reservable.
   */
  private async assertNoAvailabilityBlock(
    vehicleId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<void> {
    const blocking = await sql<{ type: string }>`
      SELECT type FROM availability
      WHERE vehicle_id = ${vehicleId}
        AND type IN ('blocked', 'maintenance')
        AND start_at < ${endAt} AND ${startAt} < end_at
      LIMIT 1
    `.execute(this.db);

    const type = blocking.rows[0]?.type;

    if (type === 'maintenance') {
      throw new ConflictException({
        code: 'VEHICLE_IN_MAINTENANCE',
        message:
          'Ce vehicule est en maintenance sur une partie de cette periode. ' +
          'Choisissez d autres dates.',
      });
    }

    if (type === 'blocked') {
      throw new ConflictException({
        code: 'VEHICLE_UNAVAILABLE',
        message: 'Ce vehicule est indisponible sur une partie de cette periode.',
      });
    }
  }

  /**
   * Resout le taux de commission selon la priorite CDCS 8.5 :
   * surcharge du partenaire, puis formule, puis defaut plateforme.
   *
   * La surcharge prime meme si elle est plus FAIBLE que la formule :
   * c'est un accord commercial negocie, pas une erreur de saisie. Le
   * figer sans l'appliquer reviendrait a facturer le partenaire au taux
   * d'une formule qu'il a explicitement renoncee a payer.
   */
  private async resolveCommission(
    providerType: ProviderType,
    agencyId: string | null,
    ownerId: string | null,
  ): Promise<ResolvedCommission> {
    const providerId = providerType === 'agency' ? agencyId : ownerId;

    const result = await sql<CommissionCandidateRow>`
      SELECT
        COALESCE(a.commission_rate, u.commission_rate)::text AS partner_rate,
        p.commission_rate::text AS plan_rate,
        (SELECT (value #>> '{}')::numeric FROM setting
          WHERE key = 'platform.default_commission_rate' AND NOT is_secret
        )::text AS platform_rate
      FROM (SELECT ${providerId}::uuid AS id) target
      LEFT JOIN agency a ON ${providerType} = 'agency' AND a.id = target.id
      LEFT JOIN "user" u ON ${providerType} = 'owner' AND u.id = target.id
      LEFT JOIN subscription s ON s.agency_id = target.id AND s.status = 'active'
      LEFT JOIN plan p ON p.id = s.plan_id
      LIMIT 1
    `.execute(this.db);

    const row = result.rows[0];
    const partner = row?.partner_rate ? Number(row.partner_rate) : null;
    const plan = row?.plan_rate ? Number(row.plan_rate) : null;
    const fallback = row?.platform_rate ? Number(row.platform_rate) : 0;

    if (partner !== null) {
      return { rate: partner, source: 'partner_override' };
    }

    if (plan !== null) {
      return { rate: plan, source: 'plan' };
    }

    return { rate: fallback, source: 'platform_default' };
  }

  /**
   * Genere une reference courte unique.
   *
   * Les caracteres ambigus (0/O, 1/I/L, 2/Z, 5/S, 8/B) sont exclus :
   * la reference est dictée au telephone au moindre depannage, et un
   * « O » pour un « 0 » fait perdre un appel.
   */
  private async newReference(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let candidate = '';
      for (let i = 0; i < 8; i += 1) {
        candidate += REFERENCE_ALPHABET[Math.floor(Math.random() * REFERENCE_ALPHABET.length)];
      }

      const exists = await sql<{ exists: SqlBool }>`
        SELECT EXISTS (SELECT 1 FROM booking WHERE reference = ${candidate})
      `.execute(this.db);

      if (!exists.rows[0]?.exists) return candidate;
    }

    throw new InternalServerErrorException(
      'Impossible de generer une reference unique apres 8 tentatives.',
    );
  }

  private async writeHistory(
    bookingId: string,
    from: BookingStatus | null,
    to: BookingStatus,
    actorId: string | null,
    reason: string,
  ): Promise<void> {
    await sql`
      INSERT INTO booking_status_history (booking_id, from_status, to_status, actor_id, reason)
      VALUES (${bookingId}, ${from}, ${to}, ${actorId}, ${reason})
    `.execute(this.db);
  }

  /**
   * Traduit les erreurs PostgreSQL en reponses HTTP.
   *
   * `23P01` est `exclusion_violation` : c'est le code que le declencheur
   * `prevent_booking_overlap` leve. Le traduire en 409 plutot qu'en 500
   * est ce qui distingue « quelqu'un a reserve ces dates entre-temps »
   * — situation normale et prevue — d'une panne.
   */
  private translate(error: unknown): unknown {
    const pg = error as { code?: string; constraint?: string; message?: string };

    if (pg?.code === '23P01' || pg?.constraint?.includes('exclusion')) {
      return new ConflictException({
        code: 'VEHICULE_DEJA_RESERVE',
        message:
          'Ce vehicule vient d etre reserve sur une partie de ces dates par une ' +
          'autre personne. Choisissez d autres dates ou un autre vehicule.',
      });
    }

    if (pg?.code === '23505') {
      return new ConflictException({
        code: 'REFERENCE_COLLISION',
        message: 'Collision de reference. Reessayez.',
      });
    }

    if (pg?.code === '23514' && pg?.message?.includes('booking_range_valid')) {
      return new BadRequestException({
        code: 'RANGE_INVALIDE',
        message: 'La fin de location doit suivre le debut.',
      });
    }

    return error;
  }
}

interface BookableVehicle {
  id: string;
  providerType: ProviderType;
  agencyId: string | null;
  ownerId: string | null;
  dailyRate: string;
  depositAmount: string;
  currencyCode: string;
}
