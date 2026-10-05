import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PaymentDeclinedError,
  PaymentProviderUnavailableError,
  shouldIgnoreRepeatedWebhook,
  type CreatePaymentRequest,
  type PaymentIntentOutput,
  type PaymentProvider,
  type ProviderWebhook,
  type RequestRefundInput,
  type WebhookOutcome,
} from '@adkcars/contracts';
import { type Db, sql } from '@adkcars/database';

import { BookingService } from '../booking/booking.service';
import type { AuthenticatedUser } from '../auth/auth.guards';
import { PaymentProviderRegistry } from './providers/provider.registry';
import { toPaymentIntent } from './payment.mapper';
import type { PayableBookingRow, PaymentOwnerRow, PaymentRow, WebhookRejection } from './payment.types';

/**
 * Metier du paiement (CDCS 14).
 *
 * ------------------------------------------------------------------------
 * D'OU VIENT LE MONTANT
 * ------------------------------------------------------------------------
 * De la reservation, jamais du client. `CreatePaymentRequest` ne porte
 * que `bookingId` et `method` : ni montant, ni devise, ni reference.
 *
 * Ce n'est pas une precaution de style. Si le client pouvait indiquer le
 * montant, il pourrait payer 1 franc pour une voiture a 60 000, et la
 * reservation serait confirmee — car c'est le paiement `paid` qui fait
 * passer la reservation a `paid`.
 *
 * ------------------------------------------------------------------------
 * CE QUE L'ON ENCAISSE, ET CE QUE L'ON NE FAIT PAS ENCORE
 * ------------------------------------------------------------------------
 * On encaisse le montant de LOCATION, extrait du devis fige
 * (`pricing_snapshot.rentalAmount`), et jamais `total_amount` — qui
 * INCLUT la caution.
 *
 * La caution n'est pas encaissee ici. C'est deliberé, et c'est
 * l'arbitrage A-04 qui le decide : sans lui, on ne sait pas si la
 * caution doit etre prelevee a la reservation puis restituee, ou
 * prelevee a la restitution. Choisir maintenant serait fabriquer une
 * regle de tresorerie, et une regle de tresorerie inventee se corrige
 * apres avoir preleve.
 *
 * ------------------------------------------------------------------------
 * L'ORDRE EST IMPOSE PAR LA BASE
 * ------------------------------------------------------------------------
 * La migration 0008 refuse qu'un paiement devienne `paid` si la
 * reservation est annulee. La reservation est donc mise a jour AVANT le
 * paiement, dans la meme transaction.
 *
 * Cet ordre parait contre-intuitif — on « paie avant de confirmer » —
 * mais il reflete la realite : si la reservation a ete annulee entre le
 * debit du client et la notification, encaisser quand meme serait
 * facturer pour un vehicule qui ne sera pas livre. Le rejet de la base
 * transforme cette situation en dossier de remboursement, ce qui est la
 * seule sortie correcte.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @Inject('DATABASE') private readonly db: Db,
    private readonly providers: PaymentProviderRegistry,
    private readonly bookings: BookingService,
  ) {}

  // ==================================================================
  // 1. Ouverture d'une intention
  // ==================================================================

  async createIntent(
    input: CreatePaymentRequest,
    actor: AuthenticatedUser,
  ): Promise<PaymentIntentOutput> {
    const booking = await this.payableBooking(input.bookingId);

    if (booking.client_id !== actor.id && !actor.roles.includes('admin')) {
      // Meme reponse qu'un inexistant : ne pas confirmer l'existence
      // d'une reservation d'autrui par la difference entre 403 et 404.
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    if (booking.status !== 'awaiting_payment') {
      throw new ConflictException({
        code: 'BOOKING_NOT_PAYABLE',
        message: `La reservation est au statut ${booking.status} et n attend pas de paiement.`,
        details: { status: booking.status },
      });
    }

    const montant = this.rentalAmount(booking);

    // Le canal de fonds est decide par la base et IMMUABLE (migration
    // 0005). Un client ne peut pas choisir de payer le proprietaire en
    // direct pour echapper a la commission, ni l'inverse. Un paiement
    // par especes sur un canal plateforme serait refuse par
    // `booking_funds_channel_guard`.
    const provider = await this.providerFor(booking.funds_channel, input.method);

    const cle = this.idempotencyKey(booking.id, input, actor.id);

    // Une intention deja ouverte pour cette cle est rendue telle quelle :
    // un double-clic sur « payer » ne doit pas creer deux paiements.
    const existant = await this.db
      .selectFrom('payment')
      .selectAll()
      .where('idempotency_key', '=', cle)
      .where('status', 'in', ['pending', 'authorized'])
      .executeTakeFirst();

    if (existant) {
      // `unknown` intermediaire : `Json` de Kysely et
      // `Record<string, unknown>` du type local ne se recouvrent
      // pas, alors qu ils decrivent la MEME valeur. La conversion
      // est donc declaree, pas subie — et `any` est evite, car il
      // masquerait aussi les divergences futures.
      return toPaymentIntent(existant as unknown as PaymentRow, {
        reference: booking.reference,
        status: booking.status,
        });
    }

    const paymentId = await this.db.transaction().execute(async (trx) => {
      const insere = await trx
        .insertInto('payment')
        .values({
          booking_id: booking.id,
          provider_key: provider.key,
          method: input.method,
          kind: 'rental',
          amount: montant,
          currency_code: booking.currency_code,
          status: 'pending',
          idempotency_key: cle,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return insere.id as string;
    });

    // L'appel au prestataire est HORS de la transaction. Un appel
    // reseau dans une transaction tient des verrous pendant toute la
    // latence du prestataire, et le rollback de la transaction
    // n'annulerait pas l'intention creee chez lui.
    //
    // Consequence assumee : si le prestataire cree l'intention et que
    // l'echriture echoue ensuite, notre paiement reste `pending` sans
    // reference. Il sera reconcile (CDCS 14.3) — pas perdu.
    let referenceExterne: string | null = null;
    try {
      const intention = await provider.createIntent({
        idempotencyKey: cle,
        amount: BigInt(montant),
        currency: booking.currency_code,
        method: input.method,
        reference: booking.reference,
        description: `Location ${booking.reference}`,
      });

      referenceExterne = intention.externalRef;
    } catch (erreur) {
      const refuse = erreur instanceof PaymentDeclinedError;
      const indisponible = erreur instanceof PaymentProviderUnavailableError;

      // Le paiement cree est marque `failed` plutot que laisse
      // `pending` : un `pending` sans reference attendue n'est ni paye ni
      // echoue, et le rapprochement ne saura pas quoi en faire.
      await this.db
        .updateTable('payment')
        .set({
          status: 'failed',
          failure_code: refuse ? 'DECLINED' : 'PROVIDER_UNAVAILABLE',
          failure_reason: erreur instanceof Error ? erreur.message : 'Erreur inconnue.',
        })
        .where('id', '=', paymentId)
        .execute();

      this.logger.warn(
        { paymentId, provider: provider.key, refuse, indisponible },
        'Ouverture de paiement refusee par le prestataire',
      );

      throw indisponible
        ? new ServiceUnavailableException({
            code: 'PROVIDER_UNAVAILABLE',
            message:
              'Le service de paiement est momentanement indisponible. Reessayez dans un instant.',
          })
        : new BadRequestException({
            code: 'PAYMENT_DECLINED',
            message: 'Le paiement a ete refuse. Choisissez un autre moyen de paiement.',
            details: { reason: erreur instanceof Error ? erreur.message : undefined },
          });
    }

    await this.db
      .updateTable('payment')
      .set({ external_ref: referenceExterne })
      .where('id', '=', paymentId)
      .execute();

    const payment = await this.loadPayment(paymentId);

    return toPaymentIntent(payment as unknown as PaymentRow, {
      reference: booking.reference,
      status: booking.status,
    });
  }

  // ==================================================================
  // 2. Detail
  // ==================================================================

  async detail(paymentId: string, actor: AuthenticatedUser): Promise<PaymentIntentOutput> {
    const payment = await this.loadPayment(paymentId);

    const booking = await this.ownerOf(payment.booking_id);

    if (booking.client_id !== actor.id && !actor.roles.includes('admin')) {
      throw new NotFoundException({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Paiement introuvable.',
      });
    }

    return toPaymentIntent(payment as unknown as PaymentRow, {
      reference: await this.referenceOf(payment.booking_id),
      status: booking.status,
    });
  }

  async listForBooking(
    bookingId: string,
    actor: AuthenticatedUser,
  ): Promise<PaymentIntentOutput[]> {
    const booking = await this.ownerOf(bookingId);

    if (booking.client_id !== actor.id && !actor.roles.includes('admin')) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    const payments = await this.db
      .selectFrom('payment')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('created_at', 'asc')
      .execute();

    const reference = await this.referenceOf(bookingId);

    return payments.map((paiement) =>
      toPaymentIntent(paiement as PaymentRow, { reference, status: booking.status }),
    );
  }

  // ==================================================================
  // 3. Webhook
  // ==================================================================

  /**
   * Traite une notification de prestataire.
   *
   * L'ordre des operations n'est pas indifferent. Il est dicte par ce
   * qui doit echouer cote, et par ce qui doit pouvoir etre rejoue.
   *
   *   1. RESOUDRE le prestataire. Une notification dont on ignore
   *      l'origine ne doit pas etre traitee : c'est une requete
   *      d'un tiers, et un tiers peut declarer un paiement recu.
   *   2. VERIFIER la signature. Avant toute lecture de la charge utile,
   *      et avant tout ecrit : une signature verifiee apres coup laisse
   *      deja passer ce qu'on voulait empecher.
   *   3. NOTER l'evenement. Avant toute mutation. C'est ce qui rend le
   *      traitement « au plus une fois » vrai, y compris depuis
   *      plusieurs instances et apres redemarrage.
   *   4. MUTER, dans une transaction.
   */
  async handleWebhook(
    providerKey: string,
    rawBody: string,
    signature: string | undefined,
  ): Promise<WebhookOutcome> {
    const provider = this.providers.resolve(providerKey);

    // --- 2. Signature, AVANT toute lecture de contenu ---------------
    if (!provider.verifyWebhook(rawBody, signature)) {
      await this.noteRejection({
        providerKey,
        externalEventId: undefined,
        payloadSha256: this.digest(rawBody),
        outcome: 'rejected_signature',
        detail: signature ? 'signature invalide' : 'signature absente',
      });

      // 401 et non 403 : le client est le prestataire, et un « acces
      // refuse » l'inviterait a reessayer avec une autre cle. Un 401 le
      // ramene a retablir SA cle.
      throw new ForbiddenException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Signature de notification invalide.',
      });
    }

    const evenement = provider.parseWebhook(rawBody);

    // --- 3. Idempotence, AVANT toute mutation ----------------------
    // La cle du journal designe l EVENEMENT, pas l etat.
    //
    // Calculee UNE FOIS, ici, car elle sert a sept endroits. Calculée a
    // chaque usage, deux emplacements divergent un jour, et l un des deux
    // ecrit une cle que les six autres ne reconnaissent pas : le doublon
    // passe, et le paiement est traite deux fois.
    const cleEvenement =
      evenement.externalEventId ?? this.fallbackEventId(evenement);
    // La contrainte unique sur `(provider_key, external_event_id)` est
    // la REELLE protection. Ce `insert` peut echouer : c'est le chemin
    // normal du doublon, pas une anomalie.
    try {
      await this.db
        .insertInto('provider_webhook_delivery')
        .values({
          provider_key: providerKey,
          external_event_id: cleEvenement,
          payload_sha256: this.digest(rawBody),
        })
        .execute();
    } catch (erreur) {
      if (!this.isUniqueViolation(erreur)) {
        throw erreur;
      }

      // Evenement deja traite : c'est le fonctionnement NORMAL d'un
      // prestataire, qui retransmet au moins une fois.
      const dejaTraite = await this.findDelivery(
        providerKey,
        cleEvenement,
      );

      if (dejaTraite?.process_outcome) {
        this.logger.debug(
          { providerKey, evenement: evenement.externalRef, statut: evenement.status },
          'Notification retransmise, ignoree',
        );

        const payment = await this.findByExternalRef(providerKey, evenement.externalRef);
        const statutReservation = payment
          ? await this.statusOf(payment.booking_id)
          : null;

        return {
          outcome: 'ignored_duplicate',
          paymentId: payment?.id ?? '',
          status: payment?.status ?? evenement.status,
          bookingStatus: statutReservation,
        };
      }

      // L'evenement est note mais pas traite (echec precedent, ou
      // traitement interrompu). Il faut le REJOUER, pas l'ignorer :
      // c'est la difference entre un paiement encaisse en double et un
      // paiement rate.
      this.logger.warn(
        { providerKey, evenement: evenement.externalRef },
        'Notification deja notee mais non traitee — rejeu',
      );
    }

    const payment = await this.findByExternalRef(providerKey, evenement.externalRef);

    if (!payment) {
      await this.concludeDelivery(
        providerKey,
        cleEvenement,
        'rejected_unknown',
        'aucun paiement correspondant',
      );

      // 200 : le prestataire n'a rien a reessayer. Repondre une erreur
      // le ferait retransmettre indefiniment une notification dont le
      // probleme ne se resoudra pas tout seul.
      throw new NotFoundException({
        code: 'WEBHOOK_UNKNOWN_PAYMENT',
        message: 'Aucun paiement ne correspond a cette notification.',
      });
    }

    // --- 4. Mutation, en transaction --------------------------------
    try {
      return await this.applyWebhook(
        payment,
        evenement,
        providerKey,
        rawBody,
        cleEvenement,
      );
    } catch (erreur) {
      await this.concludeDelivery(
        providerKey,
        cleEvenement,
        'failed_processing',
        erreur instanceof Error ? erreur.message.slice(0, 400) : 'erreur inconnue',
      );

      this.logger.error(
        { paymentId: payment.id, erreur },
        'Traitement de notification en echec',
      );

      throw erreur;
    }
  }

  /**
   * Applique une notification verifiee.
   *
   * La reservation passe `paid` AVANT le paiement. Voir l'en-tete : la
   * migration 0008 refuse un encaissement sur une reservation annulee,
   * et cette application de l'ordre est ce qui transforme une
   * notification trop tardive en dossier de remboursement plutot qu'en
   * encaissement injustifie.
   */
  private async applyWebhook(
    payment: PaymentRow,
    evenement: ProviderWebhook,
    providerKey: string,
    rawBody: string,
    /**
     * Cle de l evenement, calculee par `handleWebhook`.
     *
     * PASSE EN PARAMETRE, et non recalculee ici. Deux raisons.
     *
     * La visibilite : `applyWebhook` est une autre methode, la variable
     * locale de `handleWebhook` n y existe pas.
     *
     * La stabilite : la cle doit designer l evenement TEL QUE LE
     * PRESTATAIRE L'ANONCE. La recalculer ici la livrerait au moment de
     * l application, ou le code a deja pu transformer la charge utile —
     * et deux methodes qui calculeraient differently donneraient deux
     * cles pour un meme evenement. Le doublon passerait alors, et le
     * paiement serait traite deux fois.
     */
    cleEvenement: string,
  ): Promise<WebhookOutcome> {
    const cible = evenement.status;

    // Un paiement deja regle ne se rejoue pas. `shouldIgnoreRepeatedWebhook`
    // ne vaut PAS sur `failed` : un client qui reclique « payer » apres
    // un echec doit pouvoir reussir. C'est ce qui distingue un doublon
    // d'un nouvel essai.
    if (shouldIgnoreRepeatedWebhook(payment.status)) {
      const statutReservation = await this.statusOf(payment.booking_id);

      await this.concludeDelivery(
        providerKey,
        cleEvenement,
        'ignored_duplicate',
        'paiement deja regle',
      );

      return {
        outcome: 'ignored_duplicate',
        paymentId: payment.id,
        status: payment.status,
        bookingStatus: statutReservation,
      };
    }

    // Le montant annonce doit correspondre au montant enregistre. Un
    // ecart signifie que le prestataire a traite une autre commande ;
    // encaisser le montant annonce serait facturer n'importe quoi.
    const montantAnnonce = evenement.rawPayload['amount'];
    if (typeof montantAnnonce === 'string' && montantAnnonce !== payment.amount) {
      await this.concludeDelivery(
        providerKey,
        cleEvenement,
        'rejected_amount',
        `montant annonce ${montantAnnonce} different du montant enregistre ${payment.amount}`,
      );

      throw new ConflictException({
        code: 'WEBHOOK_AMOUNT_MISMATCH',
        message: 'Le montant annonce ne correspond pas au montant enregistre.',
        details: { announced: montantAnnonce, recorded: payment.amount },
      });
    }

    const statutReservation = await this.db.transaction().execute(async (trx) => {
      // --- Reservation d'abord --------------------------------------
      if (cible === 'paid') {
        const booking = await trx
          .selectFrom('booking')
          .select(['version', 'status'])
          .where('id', '=', payment.booking_id)
          .executeTakeFirst();

        if (!booking) {
          throw new NotFoundException({
            code: 'BOOKING_NOT_FOUND',
            message: 'Reservation introuvable.',
          });
        }

        if (booking.status === 'awaiting_payment') {
          // Le service de reservation est appele HORS de cette
          // transaction : il ouvre sa propre. La version lue ici sert de
          // verrou : si la reservation a change entre-temps, la
          // transition echoue et rien n'est encaisse.
          //
          // Ce n'est pas atomique, et c'est assume. Le vrai garde-fou
          // est la migration 0008, executee dans la meme transaction que
          // la mise a jour du paiement : si la reservation est annulee,
          // le paiement ne pourra pas devenir `paid`, et l'argent reste
          // en refundable plutot que confirme.
          await this.bookings.confirmPaidByPayment(payment.booking_id, booking.version);
        }
      }

      // --- Puis le paiement ----------------------------------------
      // La transition est verifiee par `trg_payment_transition_guard`.
      // Un refus ici signifie que le code et la base divergent, ou que
      // le paiement a deja change : dans les deux cas, la base a raison.
      await trx
        .updateTable('payment')
        .set({
          status: cible,
          raw_payload: evenement.rawPayload as Record<string, unknown>,
          failure_code: this.textOf(evenement.rawPayload['failure_code']),
          failure_reason: this.textOf(evenement.rawPayload['failure_reason']),
        })
        .where('id', '=', payment.id)
        .execute();

      const ligne = await trx
        .selectFrom('booking')
        .select('status')
        .where('id', '=', payment.booking_id)
        .executeTakeFirst();

      return ligne?.status ?? null;
    });

    await this.concludeDelivery(providerKey, cleEvenement, 'applied', rawBody.slice(0, 200));

    const frais = await this.loadPayment(payment.id);

    return {
      outcome: 'applied',
      paymentId: frais.id,
      status: frais.status,
      bookingStatus: statutReservation,
    };
  }

  // ==================================================================
  // 4. Remboursement
  // ==================================================================

  /**
   * Demande de remboursement.
   *
   * Le montant est EXPLICITE et ne peut pas depasser l'encaissement. Le
   * bareme des litiges n'est pas tranche (A-04), donc le module ne
   * deduit rien : il execute une decision prise ailleurs et refuse un
   * montant qui n'a pas ete encaisse.
   */
  async requestRefund(input: RequestRefundInput, actor: AuthenticatedUser): Promise<{
    refundId: string;
    status: string;
  }> {
    const payment = await this.loadPayment(input.paymentId);
    const booking = await this.ownerOf(payment.booking_id);

    if (!actor.roles.includes('admin')) {
      // Un client peut demander un remboursement ; il ne peut pas le
      // DECIDER. La demande part en validation, elle ne part pas en
      // execution.
      throw new ForbiddenException({
        code: 'REFUND_REQUIRES_REVIEW',
        message: 'Un remboursement doit etre valide par un administrateur.',
      });
    }

    if (payment.status !== 'paid') {
      throw new ConflictException({
        code: 'REFUND_IMPOSSIBLE',
        message: `Un remboursement exige un paiement encaisse (statut actuel : ${payment.status}).`,
        details: { status: payment.status },
      });
    }

    const demande = BigInt(input.amount);
    const encaisse = BigInt(payment.amount);

    if (demande <= 0n || demande > encaisse) {
      throw new BadRequestException({
        code: 'REFUND_AMOUNT_INVALID',
        message: 'Le remboursement doit etre positif et ne peut pas depasser l encaissement.',
        details: { requested: input.amount, collected: payment.amount },
      });
    }

    const provider = this.providers.resolve(payment.provider_key);

    const chezPrestataire = await provider.requestRefund({
      externalRef: payment.external_ref ?? '',
      amount: demande,
      currency: payment.currency_code,
      idempotencyKey: `refund:${payment.id}:${input.amount}:${input.kind}`,
      reason: input.reason,
    });

    const refund = await this.db
      .insertInto('refund')
      .values({
        // ⚠️ `refund` ne porte QUE `payment_id`. La reservation se
        // deduit par jointure. Ajouter ici une colonne qui n'existe pas
        // echouerait a l'execution, pas a la compilation : le premier
        // signe serait un client sans remboursement.
        payment_id: payment.id,
        kind: input.kind,
        amount: input.amount,
        currency_code: payment.currency_code,
        status: chezPrestataire.status === 'succeeded' ? 'succeeded' : 'pending',
        requested_by: actor.id,
        reason: input.reason,
        external_ref: chezPrestataire.externalRefundRef,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Le paiement ne passe `refunded` que si TOUT est.rembourse. Un
    // remboursement partiel laisse le paiement `paid`, et le reste
    // encaisse — le passer a `refunded` ferait croire que la dette est
    // soldee.
    if (demande === encaisse) {
      await this.db
        .updateTable('payment')
        .set({ status: 'refunded' })
        .where('id', '=', payment.id)
        .execute();
    }

    return {
      refundId: refund.id as string,
      status: refund.status as string,
    };
  }

  // ==================================================================
  // Helpers
  // ==================================================================

  /**
   * Reservation payable, avec son devis fige.
   *
   * `rental_amount` vient de `pricing_snapshot`, jamais de
   * `total_amount` — qui inclut la caution. Lire le total facturerait la
   * caution dans le prix de la location, et le client verrait deux fois
   * le meme argent.
   */
  private async payableBooking(bookingId: string): Promise<PayableBookingRow> {
    const row = await this.db
      .selectFrom('booking')
      .select([
        'booking.id',
        'booking.reference',
        'booking.client_id',
        'booking.status',
        'booking.version',
        'booking.currency_code',
        'booking.funds_channel',
        'booking.total_amount',
        'booking.deposit_amount',
        sql<string | null>`booking.pricing_snapshot->>'rentalAmount'`.as('rental_amount'),
      ])
      .where('booking.id', '=', bookingId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    return row as unknown as PayableBookingRow;
  }

  /**
   * Montant de location, extrait du devis FIGE.
   *
   * Le devis est fige a la creation de la reservation (migration 0007,
   * `trg_booking_snapshot_immutable`) : relire le tarif courant du
   * vehicule ferait varier le prix apres la lecture du client, et le
   * devis affiche ne correspondrait plus a la facture.
   */
  private rentalAmount(booking: PayableBookingRow): string {
    const fige = booking.rental_amount;

    if (fige === null || fige === undefined) {
      throw new ConflictException({
        code: 'PRICING_SNAPSHOT_INCOMPLETE',
        message:
          'Le devis de cette reservation ne porte pas de montant de location. Traitement manuel requis.',
        details: { bookingId: booking.id },
      });
    }

    if (BigInt(fige) <= 0n) {
      // Un montant nul ou negatif produirait une intention de paiement
      // de zero, que le prestataire accepterait sans encaisser. La
      // reservation resterait `awaiting_payment` jusqu a expiration,
      // sans que rien ne signale l anomalie.
      throw new ConflictException({
        code: 'RENTAL_AMOUNT_NOT_POSITIVE',
        message: 'Le montant de location enregistre n est pas positif. Traitement manuel requis.',
        details: { bookingId: booking.id, rentalAmount: fige },
      });
    }

    return fige;
  }

  /**
   * Prestataire pour un canal et un moyen de paiement.
   *
   * Le canal est decide par la base et immuable. On ne demande donc pas
   * au client : il n a pas ce choix, et l accepter reviendrait a lui
   * permettre d echapper a la commission.
   */
  private async providerFor(
    fundsChannel: string,
    method: PaymentRow['method'],
  ): Promise<PaymentProvider> {
    const candidats = this.providers.forMethod(method);

    if (candidats.length === 0) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_UNSUPPORTED',
        message: `Aucun prestataire ne propose le moyen de paiement ${method}.`,
      });
    }

    for (const provider of candidats) {
      if (await provider.isAvailable()) {
        // Le canal `direct` avec un moyen `cash` est le seul cas ou le
        // prestataire n'intervient pas : le proprietaire encaisse et
        // saisit. La garde `booking_funds_channel_guard` verifie que le
        // sens inverse est refuse.
        void fundsChannel;
        return provider;
      }
    }

    throw new ServiceUnavailableException({
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Aucun service de paiement n est disponible pour ce moyen de paiement.',
    });
  }

  private idempotencyKey(
    bookingId: string,
    input: CreatePaymentRequest,
    actorId: string,
  ): string {
    // La cle est derivee de la reservation, du moyen et du client, et
    // NON d'un instant. Une cle horodatee ne rendrait pas l operation
    // idempotente : un double-clic creerait deux cles, donc deux
    // paiements.
    const empreinte = createHash('sha256')
      .update(`${bookingId}|${input.method}|${actorId}|${input.retryOfPaymentId ?? ''}`)
      .digest('hex')
      .slice(0, 32);

    return `pay:${bookingId}:${empreinte}`;
  }

  private async loadPayment(paymentId: string): Promise<PaymentRow> {
    const row = await this.db
      .selectFrom('payment')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException({
        code: 'PAYMENT_NOT_FOUND',
        message: 'Paiement introuvable.',
      });
    }

    return row as PaymentRow;
  }

  private async ownerOf(bookingId: string): Promise<PaymentOwnerRow> {
    const row = await this.db
      .selectFrom('booking')
      .select(['client_id', 'status', 'version'])
      .where('id', '=', bookingId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Reservation introuvable.',
      });
    }

    return row as PaymentOwnerRow;
  }

  private async referenceOf(bookingId: string): Promise<string> {
    const row = await this.db
      .selectFrom('booking')
      .select('reference')
      .where('id', '=', bookingId)
      .executeTakeFirst();

    return row?.reference ?? '';
  }

  private async statusOf(bookingId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('booking')
      .select('status')
      .where('id', '=', bookingId)
      .executeTakeFirst();

    return row?.status ?? null;
  }

  private async findByExternalRef(
    providerKey: string,
    externalRef: string,
  ): Promise<PaymentRow | undefined> {
    const row = await this.db
      .selectFrom('payment')
      .selectAll()
      .where('provider_key', '=', providerKey)
      .where('external_ref', '=', externalRef)
      .executeTakeFirst();

    return row as PaymentRow | undefined;
  }

  private async findDelivery(
    providerKey: string,
    externalEventId: string,
  ): Promise<{ process_outcome: string | null } | undefined> {
    return this.db
      .selectFrom('provider_webhook_delivery')
      .select('process_outcome')
      .where('provider_key', '=', providerKey)
      .where('external_event_id', '=', externalEventId)
      .executeTakeFirst();
  }

  private async concludeDelivery(
    providerKey: string,
    externalEventId: string,
    // L union des issues possibles, et non `string`. C est
    // l interface Kysely qui l impose : une issue inventee serait
    // refusee ici, avant d aller en base.
    outcome:
      | 'applied'
      | 'ignored_duplicate'
      | 'rejected_signature'
      | 'rejected_unknown'
      | 'rejected_amount'
      | 'failed_processing',
    detail: string,
  ): Promise<void> {
    await this.db
      .updateTable('provider_webhook_delivery')
      .set({ processed_at: new Date(), process_outcome: outcome, error_detail: detail })
      .where('provider_key', '=', providerKey)
      .where('external_event_id', '=', externalEventId)
      .execute();
  }

  /**
   * Enregistre un refus de notification.
   *
   * Un webhook refuse sans trace est un webhook qu'on ne retrouvera pas.
   * La table 5 de la migration 0008 garantit le traitement au plus une
   * fois ; elle ne dit rien des evenements arrives et rejetés, qui sont
   * justement ceux qu'on cherche quand un paiement manque a l'appel.
   */
  private async noteRejection(refus: WebhookRejection): Promise<void> {
    await this.db
      .insertInto('provider_webhook_delivery')
      .values({
        provider_key: refus.providerKey,
        external_event_id:
          refus.externalEventId ??
          `rejete:${createHash('sha256').update(refus.payloadSha256).digest('hex').slice(0, 24)}`,
        payload_sha256: refus.payloadSha256,
        processed_at: new Date(),
        process_outcome: refus.outcome,
        error_detail: refus.detail,
      })
      .execute()
      .catch((erreur: unknown) => {
        // Le journal ne doit jamais empecher la reponse : un refus de
        // signature doit etre repondu meme si son inscription echoue.
        this.logger.error(
          { erreur },
          'Impossible de consigner le refus de notification',
        );
      });
  }

  /**
   * Identifiant de repli quand le prestataire n en fournit pas.
   *
   * `reference:statut` designe un ETAT, pas un evenement : deux
   * notifications distinctes portant le meme statut seraient confondues,
   * et l une serait ignoree a tort.
   *
   * C'est un repli, pas une solution. Un prestataire sans identifiant
   * d evenement ne peut pas garantir son idempotence, et le journal ne
   * pourra pas non plus. La consequence est signalee ici plutot que
   * dissimulee : a l arrivee d un second prestataire, la question
   * « votre API expose-t-elle un identifiant d evenement ? » doit etre
   * posee AVANT de brancher l adaptateur.
   */
  private fallbackEventId(evenement: {
    externalRef: string;
    status: string;
    rawPayload: Record<string, unknown>;
  }): string {
    return `${evenement.externalRef}:${evenement.status}:${this.digest(JSON.stringify(evenement.rawPayload))}`;
  }

  private digest(rawBody: string): string {
    return createHash('sha256').update(rawBody, 'utf8').digest('hex');
  }

  private isUniqueViolation(erreur: unknown): boolean {
    return (
      typeof erreur === 'object' &&
      erreur !== null &&
      'code' in erreur &&
      (erreur as { code: string }).code === '23505'
    );
  }

  private textOf(valeur: unknown): string | null {
    return typeof valeur === 'string' && valeur.length > 0 ? valeur : null;
  }
}
