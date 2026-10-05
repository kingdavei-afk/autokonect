import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type Expression,
  type ExpressionBuilder,
  sql,
  type SqlBool,
  type Db,
} from '@adkcars/database';
import {
  buildPagination,
  cents,
  OCCUPYING_STATUSES,
  type CreateVehicleInput,
  type Pagination,
  type PublicationReadiness,
  type UpdateVehicleInput,
  type UploadDocumentInput,
  type VehicleDetail,
  type VehicleSearchInput,
  type VehicleSummary,
} from '@adkcars/contracts';

import { DATABASE } from '../../common/tokens';
import type { AuthenticatedUser } from '../auth/auth.guards';
import { toSummary } from './vehicles.mapper';
import type { VehicleRow } from './vehicles.types';

/** Documents exiges pour publier un vehicule (CDCS 3.1). */
const REQUIRED_DOCUMENTS = ['registration', 'insurance'] as const;

const DOCUMENT_LABELS: Record<string, string> = {
  registration: 'carte grise',
  insurance: "attestation d'assurance",
  rca: 'assurance responsabilite civile',
  technical_control: 'controle technique',
  agency_licence: 'agrement de loueur',
};

/** Plafond du tarif journalier : garde-fou contre une erreur de saisie. */
const MAX_DAILY_RATE = 100_000_000n;

/**
 * Metier du catalogue vehicule.
 *
 * Toute lecture et toute ecriture passe par une clause de propriete :
 * l'interface n'est jamais la frontiere de securite, c'est la requete
 * SQL qui est filtree par proprietaire (CDCS 12.3).
 */
@Injectable()
export class VehiclesService {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  // ==================================================================
  // Creation
  // ==================================================================

  /**
   * Cree un vehicule a l'etat brouillon.
   *
   * Un vehicule n'est JAMAIS publie directement : il passe par la
   * validation d'un administrateur (CDCS 7.2). Creer et publier d'un
   * coup est le raccourci qui ferait apparaitre des vehicules non
   * conformes dans la recherche.
   */
  async create(
    input: CreateVehicleInput,
    actor: AuthenticatedUser,
  ): Promise<VehicleDetail> {
    const provider = this.providerFor(actor);
    const rate = cents(input.dailyRate as string | number);
    const deposit = cents(input.depositAmount as string | number);

    if (rate <= 0n) {
      throw new UnprocessableEntityException({
        code: 'INVALID_DAILY_RATE',
        message: 'Le tarif journalier doit etre superieur a zero.',
      });
    }

    if (rate > MAX_DAILY_RATE) {
      throw new UnprocessableEntityException({
        code: 'DAILY_RATE_TOO_HIGH',
        message: 'Le tarif journalier depasse le plafond autorise. Verifiez la saisie.',
      });
    }

    const existing = await this.findByPlate(input.plateCountry, input.plateNumber);
    if (existing) {
      throw new ConflictException({
        code: 'PLATE_ALREADY_USED',
        message: 'Un vehicule utilise deja cette immatriculation.',
      });
    }

    const created = await sql<{ id: string }>`
      INSERT INTO vehicle (
        provider_type, agency_id, owner_id, category_id,
        brand, model, year, plate_country, plate_number, color,
        transmission, fuel, seats, air_conditioning, doors,
        luggage_capacity, consumption, daily_rate, deposit_amount,
        currency_code, with_driver, driver_included_in_rate,
        min_days, max_km_per_day, location_id, status
      )
      VALUES (
        ${provider.providerType}, ${provider.agencyId}, ${provider.ownerId},
        ${input.categoryId},
        ${input.brand}, ${input.model}, ${input.year},
        ${input.plateCountry}, ${input.plateNumber}, ${input.color ?? null},
        ${input.transmission}, ${input.fuel}, ${input.seats},
        ${input.airConditioning}, ${input.doors ?? null},
        ${input.luggageCapacity ?? null}, ${input.consumption ?? null},
        ${rate.toString()}, ${deposit.toString()},
        ${input.currencyCode}, ${input.withDriver}, ${input.driverIncludedInRate},
        ${input.minDays}, ${input.maxKmPerDay ?? null},
        ${input.locationId ?? null}, 'draft'
      )
      RETURNING id
    `.execute(this.db);

    const id = created.rows[0]?.id;
    if (!id) throw new Error('creation du vehicule sans ligne retournee');

    await this.replaceFeatures(id, input.features);

    return this.findOneForManagement(id, actor);
  }

  // ==================================================================
  // Modification
  // ==================================================================

  /**
   * Modifie un vehicule.
   *
   * Un vehicule publie qui recoit une modification de ses conditions
   * commerciales repasse en revue : le tarif d'un vehicule visible ne
   * peut pas changer sans controle (CDCS 7.2).
   */
  async update(
    id: string,
    input: UpdateVehicleInput,
    actor: AuthenticatedUser,
  ): Promise<VehicleDetail> {
    const current = await this.requireManageable(id, actor);

    const touchesCommercialTerms =
      input.dailyRate !== undefined ||
      input.depositAmount !== undefined ||
      input.withDriver !== undefined ||
      input.driverIncludedInRate !== undefined;

    if (
      current.status === 'in_review' &&
      (input.brand !== undefined || input.model !== undefined)
    ) {
      throw new ConflictException({
        code: 'VEHICLE_IN_REVIEW',
        message:
          'Le vehicule est en cours de validation. Les caracteristiques ne peuvent ' +
          'pas etre modifiees tant que la validation n a pas abouti.',
      });
    }

    if (touchesCommercialTerms && current.status === 'published') {
      throw new ConflictException({
        code: 'RESUBMIT_FOR_REVIEW',
        message:
          'Modifier le tarif ou la caution d un vehicule publie le renvoie en ' +
          'validation. Suspendez temporairement le vehicule ou faites valider la ' +
          'modification.',
      });
    }

    const patch: Record<string, unknown> = {};
    const assign = (key: string, value: unknown): void => {
      if (value !== undefined) patch[key] = value;
    };

    assign('category_id', input.categoryId);
    assign('brand', input.brand);
    assign('model', input.model);
    assign('year', input.year);
    assign('color', input.color ?? null);
    assign('transmission', input.transmission);
    assign('fuel', input.fuel);
    assign('seats', input.seats);
    assign('air_conditioning', input.airConditioning);
    assign('doors', input.doors ?? null);
    assign('luggage_capacity', input.luggageCapacity ?? null);
    assign('consumption', input.consumption ?? null);
    assign('with_driver', input.withDriver);
    assign('driver_included_in_rate', input.driverIncludedInRate);
    assign('min_days', input.minDays);
    assign('max_km_per_day', input.maxKmPerDay ?? null);
    assign('location_id', input.locationId ?? null);

    if (input.dailyRate !== undefined) {
      const rate = cents(input.dailyRate as string | number);
      if (rate <= 0n) {
        throw new UnprocessableEntityException({
          code: 'INVALID_DAILY_RATE',
          message: 'Le tarif journalier doit etre superieur a zero.',
        });
      }
      if (rate > MAX_DAILY_RATE) {
        throw new UnprocessableEntityException({
          code: 'DAILY_RATE_TOO_HIGH',
          message: 'Le tarif journalier depasse le plafond autorise.',
        });
      }
      patch['daily_rate'] = rate.toString();
    }

    if (input.depositAmount !== undefined) {
      patch['deposit_amount'] = cents(input.depositAmount as string | number).toString();
    }

    // Version optimiste : deux editions concurrentes ne doivent pas
    // s'ecraser mutuellement (CDCS 9.2).
    const result = await sql`
      UPDATE vehicle
      SET ${sql.raw(this.buildAssignments(patch))}
      WHERE id = ${id} AND version = ${current.version}
    `.execute(this.db);

    if (Number(result.numAffectedRows ?? 0n) === 0) {
      throw new ConflictException({
        code: 'CONCURRENT_MODIFICATION',
        message:
          'Le vehicule a ete modifie entre-temps par une autre session. ' +
          'Rechargez et reessayez.',
      });
    }

    if (input.features !== undefined) {
      await this.replaceFeatures(id, input.features);
    }

    return this.findOneForManagement(id, actor);
  }

  /**
   * Construit la clause SET a partir de valeurs deja typees.
   *
   * Les noms de colonnes proviennent d'une liste fermee definie dans
   * `update` : aucune valeur client n'entre dans la chaine SQL
   * (CDCS 12.4).
   */
  private buildAssignments(patch: Record<string, unknown>): string {
    const columns = Object.keys(patch);
    if (columns.length === 0) return 'version = version';

    return [...columns.map((column) => `${column} = ??`), 'version = version + 1'].join(
      ', ',
    );
  }

  // ==================================================================
  // Documents de conformite
  // ==================================================================

  async attachDocument(
    vehicleId: string,
    input: UploadDocumentInput,
    actor: AuthenticatedUser,
  ): Promise<PublicationReadiness> {
    await this.requireManageable(vehicleId, actor);

    await sql`
      INSERT INTO vehicle_document
        (vehicle_id, kind, file_url, issued_at, expires_at, status)
      VALUES (
        ${vehicleId}, ${input.kind}, ${input.fileUrl},
        ${input.issuedAt ?? null}, ${input.expiresAt ?? null}, 'pending'
      )
      ON CONFLICT (vehicle_id, kind) DO UPDATE
        SET file_url = EXCLUDED.file_url,
            issued_at = EXCLUDED.issued_at,
            expires_at = EXCLUDED.expires_at,
            status = 'pending',
            reject_reason = NULL,
            updated_at = now()
    `.execute(this.db);

    return this.publicationReadiness(vehicleId);
  }

  /**
   * Verifie si un vehicule peut etre soumis a publication.
   *
   * Expose comme methode distincte pour que le front affiche la liste
   * des manquements AVANT que le fournisseur ne tente la publication.
   */
  async publicationReadiness(vehicleId: string): Promise<PublicationReadiness> {
    const documents = await sql<{
      kind: string;
      expires_at: string | null;
      status: string;
    }>`
      SELECT kind, expires_at, status FROM vehicle_document
      WHERE vehicle_id = ${vehicleId}
    `.execute(this.db);

    const byKind = new Map(documents.rows.map((row) => [row.kind, row]));
    const missingDocuments: string[] = [];
    const expiredDocuments: string[] = [];
    const reasons: string[] = [];

    for (const kind of REQUIRED_DOCUMENTS) {
      const doc = byKind.get(kind);

      if (!doc) {
        missingDocuments.push(kind);
        reasons.push(`${DOCUMENT_LABELS[kind] ?? kind} manquant`);
        continue;
      }

      // Un document marque valide mais dont la date d'expiration est
      // passee doit-etre renouvele.
      if (doc.expires_at && new Date(doc.expires_at).getTime() <= Date.now()) {
        expiredDocuments.push(kind);
        reasons.push(`${DOCUMENT_LABELS[kind] ?? kind} expire`);
      }
    }

    return {
      ready: missingDocuments.length === 0 && expiredDocuments.length === 0,
      missingDocuments: missingDocuments as PublicationReadiness['missingDocuments'],
      expiredDocuments: expiredDocuments as PublicationReadiness['expiredDocuments'],
      reasons,
    };
  }

  // ==================================================================
  // Recherche
  // ==================================================================

  /**
   * Recherche paginee de vehicules publies.
   *
   * Les filtres sont composes avec le constructeur d'expressions
   * Kysely : les valeurs client sont toujours des parametres lies,
   * jamais de chaine concatenee (CDCS 12.4).
   */
  async search(
    input: VehicleSearchInput,
  ): Promise<{ items: VehicleSummary[]; pagination: Pagination }> {
    const escape = (eb: ExpressionBuilder<any, any>) => {
      const filters: Expression<SqlBool>[] = [
        eb('vehicle.status', '=', 'published' as const),
        eb('vehicle.deleted_at', 'is', null),
      ];

      if (input.q) {
        // Recherche plein texte insensible aux accents, avec repli
        // trigramme pour la saisie partielle (CDCS 11.9).
        const term = sql`unaccent(${input.q})`;
        const tsQuery = sql`plainto_tsquery('simple', ${term})`;

        // `eb.or` et non `eb.fn('or', ...) : ce dernier produit
        // `or(a, b, c)`, invalide apres un `and`.
        filters.push(
          eb.or([
            sql<boolean>`${eb.ref('vehicle.search_vector')} @@ ${tsQuery}`,
            sql<boolean>`${eb.ref('vehicle.brand')} % ${term}`,
            sql<boolean>`${eb.ref('vehicle.model')} % ${term}`,
          ]),
        );
      }

      if (input.categoryId)
        filters.push(eb('vehicle.category_id', '=', input.categoryId));
      if (input.locationId)
        filters.push(eb('vehicle.location_id', '=', input.locationId));
      if (input.transmission)
        filters.push(eb('vehicle.transmission', '=', input.transmission));
      if (input.fuel) filters.push(eb('vehicle.fuel', '=', input.fuel));
      if (input.seats !== undefined)
        filters.push(eb('vehicle.seats', '>=', input.seats));
      if (input.yearFrom !== undefined)
        filters.push(eb('vehicle.year', '>=', input.yearFrom));
      if (input.yearTo !== undefined)
        filters.push(eb('vehicle.year', '<=', input.yearTo));
      if (input.minPrice !== undefined)
        filters.push(
          sql`${eb.ref('vehicle.daily_rate')} >= ${String(input.minPrice)}`,
        );
      if (input.maxPrice !== undefined)
        filters.push(
          sql`${eb.ref('vehicle.daily_rate')} <= ${String(input.maxPrice)}`,
        );
      if (input.withDriver !== undefined)
        filters.push(eb('vehicle.with_driver', '=', input.withDriver));
      if (input.airConditioning !== undefined)
        filters.push(
          eb('vehicle.air_conditioning', '=', input.airConditioning),
        );
      if (input.minRating !== undefined)
        filters.push(
          sql`coalesce(${eb.ref('vehicle.rating')}, 0) >= ${input.minRating}`,
        );

      // ---- Disponibilite --------------------------------------------
      if (input.availableFrom && input.availableTo) {
        const from = input.availableFrom;
        const to = input.availableTo;
        const occupying = [...OCCUPYING_STATUSES];

        // Aucun chevauchement avec une reservation existante
        // (bornes exclusives, CDCS 8.2).
        filters.push(
          sql`NOT EXISTS (
            SELECT 1 FROM booking b
            WHERE b.vehicle_id = ${eb.ref('vehicle.id')}
              AND b.status = ANY(${sql.raw(`ARRAY[${occupying.map((s) => `'${s}'`).join(',')}]::text[]`)})
              AND b.start_at < ${to}
              AND ${from} < b.end_at
          )`,
        );

        // Ni blocage manuel ni maintenance sur la plage.
        filters.push(
          sql`NOT EXISTS (
            SELECT 1 FROM availability a
            WHERE a.vehicle_id = ${eb.ref('vehicle.id')}
              AND a.type IN ('blocked', 'maintenance')
              AND a.start_at < ${to}
              AND ${from} < a.end_at
          )`,
        );
      }

      return eb.and(filters);
    };

    const base = this.db
      .selectFrom('vehicle')
      .innerJoin('vehicle_category', 'vehicle_category.id', 'vehicle.category_id')
      .select([
        'vehicle.id',
        'vehicle.brand',
        'vehicle.model',
        'vehicle.year',
        'vehicle.category_id',
        'vehicle.transmission',
        'vehicle.fuel',
        'vehicle.seats',
        'vehicle.daily_rate',
          'vehicle.deposit_amount',
        'vehicle.currency_code',
        'vehicle.with_driver',
        'vehicle.rating',
        'vehicle.ratings_count',
        'vehicle.location_id',
      ])
      .select((eb) => [
        eb.ref('vehicle_category.label').as('category_label'),
        eb
          .selectFrom('vehicle_media')
          .whereRef('vehicle_media.vehicle_id', '=', 'vehicle.id')
          .orderBy('vehicle_media.is_cover', 'desc')
          .orderBy('vehicle_media.sort_order', 'asc')
          .select('vehicle_media.url')
          .limit(1)
          .as('cover_url'),
      ]);

    const applySort = <T extends typeof base>(query: T): T => {
      switch (input.sort) {
        case 'price_asc':
          return query.orderBy('vehicle.daily_rate', 'asc') as T;
        case 'price_desc':
          return query.orderBy('vehicle.daily_rate', 'desc') as T;
        case 'rating_desc':
          return query.orderBy('vehicle.rating', 'desc').orderBy(
            'vehicle.published_at',
            'desc',
          ) as T;
        case 'newest':
          return query.orderBy('vehicle.published_at', 'desc') as T;
        default:
          return query.orderBy('vehicle.published_at', 'desc') as T;
      }
    };

    const rows = await applySort(base.where(escape).limit(input.perPage).offset(
      (input.page - 1) * input.perPage,
    )).execute();

    const countRow = await this.db
      .selectFrom('vehicle')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(escape)
      .executeTakeFirst();

    const total = Number(countRow?.['total'] ?? 0);

    return {
      items: rows.map((row) => toSummary(row)),
      pagination: buildPagination(input.page, input.perPage, total),
    };
  }

  /** Vehicules dont l'utilisateur est le proprietaire. */
  async listMine(actor: AuthenticatedUser): Promise<VehicleSummary[]> {
    const rows = await this.db
      .selectFrom('vehicle')
      .innerJoin('vehicle_category', 'vehicle_category.id', 'vehicle.category_id')
      .select([
        'vehicle.id',
        'vehicle.brand',
        'vehicle.model',
        'vehicle.year',
        'vehicle.category_id',
        'vehicle.transmission',
        'vehicle.fuel',
        'vehicle.seats',
        'vehicle.daily_rate',
          'vehicle.deposit_amount',
        'vehicle.currency_code',
        'vehicle.with_driver',
        'vehicle.rating',
        'vehicle.ratings_count',
        'vehicle.location_id',
      ])
      .select((eb) => [
        eb.ref('vehicle_category.label').as('category_label'),
        eb
          .selectFrom('vehicle_media')
          .whereRef('vehicle_media.vehicle_id', '=', 'vehicle.id')
          .orderBy('vehicle_media.is_cover', 'desc')
          .orderBy('vehicle_media.sort_order', 'asc')
          .select('vehicle_media.url')
          .limit(1)
          .as('cover_url'),
      ])
      .where('vehicle.provider_type', '=', 'owner')
      .where('vehicle.owner_id', '=', actor.id)
      .where('vehicle.deleted_at', 'is', null)
      .orderBy('vehicle.created_at', 'desc')
      .execute();

    return rows.map((row) => toSummary(row));
  }

  // ==================================================================
  // Lecture
  // ==================================================================

  async findOne(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<VehicleDetail> {
    const vehicle = await this.rawById(id);
    if (!vehicle) throw VehiclesService.notFound();

    const isAdmin = actor.roles.includes('admin');
    const isOwner = vehicle.owner_id === actor.id;

    // Un vehicule non publie n'est visible que par son proprietaire ou
    // par un administrateur : le rendre visible a tous exposerait des
    // annonces en attente de controle.
    if (vehicle.status !== 'published' && !isAdmin && !isOwner) {
      throw VehiclesService.notFound();
    }

    const [media, documents, features] = await Promise.all([
      this.db
        .selectFrom('vehicle_media')
        .selectAll()
        .where('vehicle_id', '=', id)
        .orderBy('is_cover', 'desc')
        .orderBy('sort_order', 'asc')
        .execute(),
      this.db
        .selectFrom('vehicle_document')
        .selectAll()
        .where('vehicle_id', '=', id)
        .orderBy('kind', 'asc')
        .execute(),
      this.db
        .selectFrom('vehicle_feature')
        .select('code')
        .where('vehicle_id', '=', id)
        .orderBy('code', 'asc')
        .execute(),
    ]);

    return {
      ...toSummary({
        ...vehicle,
        category_label: '',
        cover_url: media.find((m) => m.is_cover)?.url ?? null,
      }),
      plateCountry: vehicle.plate_country,
      plateNumber: vehicle.plate_number,
      color: vehicle.color,
      airConditioning: vehicle.air_conditioning,
      doors: vehicle.doors,
      luggageCapacity: vehicle.luggage_capacity,
      consumption: vehicle.consumption !== null ? Number(vehicle.consumption) : null,
      depositAmount: vehicle.deposit_amount,
      driverIncludedInRate: vehicle.driver_included_in_rate,
      minDays: vehicle.min_days,
      maxKmPerDay: vehicle.max_km_per_day,
      status: vehicle.status as VehicleDetail['status'],
      features: features.map((f) => f.code),
      media: media.map((m) => ({
        id: m.id,
        kind: m.kind,
        url: m.url,
        width: m.width ?? undefined,
        height: m.height ?? undefined,
        sortOrder: m.sort_order,
        isCover: m.is_cover,
      })),
      documents: documents.map((d) => ({
        id: d.id,
        kind: d.kind,
        fileUrl: d.file_url,
        issuedAt: d.issued_at ? new Date(d.issued_at).toISOString() : null,
        expiresAt: d.expires_at ? new Date(d.expires_at).toISOString() : null,
        status: d.status,
        rejectReason: d.reject_reason,
      })),
      createdAt: new Date(vehicle.created_at).toISOString(),
      updatedAt: new Date(vehicle.updated_at).toISOString(),
    };
  }

  /** LectureDetaillee pour le proprietaire ou l'administrateur. */
  private async findOneForManagement(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<VehicleDetail> {
    return this.findOne(id, actor);
  }

  // ==================================================================
  // Transitions de statut
  // ==================================================================

  /**
   * Soumet un vehicule a validation.
   *
   * Les documents sont verifies AVANT la soumission : le proprietaire
   * ne doit pas decouvrir les manquements apres une semaine
   * d'attente.
   */
  async submitForReview(id: string, actor: AuthenticatedUser): Promise<PublicationReadiness> {
    const vehicle = await this.requireManageable(id, actor);

    if (vehicle.status === 'in_review') {
      throw new ConflictException({
        code: 'ALREADY_IN_REVIEW',
        message: 'Le vehicule est deja en cours de validation.',
      });
    }

    if (vehicle.status === 'published') {
      throw new ConflictException({
        code: 'ALREADY_PUBLISHED',
        message: 'Le vehicule est deja publie.',
      });
    }

    const readiness = await this.publicationReadiness(id);

    if (!readiness.ready) {
      throw new UnprocessableEntityException({
        code: 'DOCUMENTS_INCOMPLETE',
        message: 'Documents manquants ou expires.',
        details: readiness,
      });
    }

    await sql`UPDATE vehicle SET status = 'in_review' WHERE id = ${id}`.execute(
      this.db,
    );

    return readiness;
  }

  // ==================================================================
  // Helpers
  // ==================================================================

  /**
   * Determine le fournisseur d'un vehicule selon le role de l'acteur.
   *
   * Un administrateur ne publie pas de vehicule : il ne fait que
   * valider. Lui attribuer une propriete creerait des annonces orphelines.
   */
  private providerFor(actor: AuthenticatedUser): {
    providerType: 'owner' | 'agency';
    ownerId: string | null;
    agencyId: string | null;
  } {
    if (actor.roles.includes('admin')) {
      throw new ForbiddenException({
        code: 'ADMIN_CANNOT_PUBLISH',
        message:
          'Un administrateur valide les vehicules mais nen publie pas. ' +
          'Requis : role proprietaire.',
      });
    }

    return { providerType: 'owner', ownerId: actor.id, agencyId: null };
  }

  private async rawById(id: string): Promise<VehicleRow | undefined> {
    const row = await this.db
      .selectFrom('vehicle')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return row as VehicleRow | undefined;
  }

  private async findByPlate(
    country: string,
    plate: string,
  ): Promise<{ id: string } | undefined> {
    return this.db
      .selectFrom('vehicle')
      .select('id')
      .where('plate_country', '=', country)
      .where('plate_number', '=', plate)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  /**
   * Verifie le droit de modification et retourne le vehicule.
   *
   * Renvoie 404 et non 403 : repondre « interdit » confirmerait
   * l'existence d'une annonce appartenant a quelqu'un d'autre
   * (CDCS 12.4).
   */
  private async requireManageable(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<VehicleRow> {
    const vehicle = await this.rawById(id);

    if (!vehicle) throw VehiclesService.notFound();

    const allowed =
      actor.roles.includes('admin') ||
      vehicle.owner_id === actor.id ||
      (vehicle.agency_id !== null && actor.roles.includes('agency'));

    if (!allowed) throw VehiclesService.notFound();

    return vehicle;
  }

  private async replaceFeatures(vehicleId: string, features: string[]): Promise<void> {
    await this.db
      .deleteFrom('vehicle_feature')
      .where('vehicle_id', '=', vehicleId)
      .execute();

    if (features.length === 0) return;

    for (const feature of features) {
      await this.db
        .insertInto('vehicle_feature')
        .values({ vehicle_id: vehicleId, code: feature, label: feature })
        .onConflict((oc) =>
          oc.columns(['vehicle_id', 'code']).doNothing(),
        )
        .execute();
    }
  }

  private static notFound(): NotFoundException {
    return new NotFoundException({
      code: 'VEHICLE_NOT_FOUND',
      message: 'Vehicule introuvable.',
    });
  }
}
