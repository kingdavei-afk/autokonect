import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
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
  type Pagination,
  type ReviewDecision,
  type ReviewDocument,
  type ReviewDocumentDecision,
  type ReviewQueueItem,
  type ReviewQueueQuery,
  type VehicleReviewDetail,
} from '@adkcars/contracts';

import { DATABASE } from '../../common/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../auth/auth.guards';

/**
 * Documents exiges pour autoriser la publication (CDCS 3.1).
 *
 * Doit correspondre a `REQUIRED_DOCUMENTS` du module vehicule.
 */
const REQUIRED_DOCUMENTS = ['registration', 'insurance'] as const;

const DOCUMENT_LABELS: Record<string, string> = {
  registration: 'carte grise',
  insurance: "attestation d'assurance",
  rca: 'assurance responsabilite civile',
  technical_control: 'controle technique',
  agency_licence: 'agrement de loueur',
};

/**
 * Revue administrative des vehicules.
 *
 * Regle de conception : le back-office ne MODIFIE PAS le contenu d'un
 * vehicule. Il decide de sa visibilite et motive ses refus. Toute
 * correction passe par le fournisseur, ce qui garantit que l'annonce
 * publiee est exactement celle que le fournisseur a vue.
 */
@Injectable()
export class AdminVehiclesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  // ==================================================================
  // File d'attente
  // ==================================================================

  async queue(
    query: ReviewQueueQuery,
  ): Promise<{ items: ReviewQueueItem[]; pagination: Pagination }> {
    // Les filtres sont composes avec le constructeur d'expressions
    // Kysely : aucune valeur client n'entre dans une chaine SQL
    // (CDCS 12.4).
    const escape = (eb: ExpressionBuilder<any, any>): Expression<SqlBool> => {
      const filters: Expression<SqlBool>[] = [];

      if (query.status !== 'all') {
        filters.push(eb('vehicle.status', '=', query.status as never));
      }
      if (query.ownerId) {
        filters.push(eb('vehicle.owner_id', '=', query.ownerId));
      }
      if (query.q) {
        const term = `%${query.q}%`;
        filters.push(
          eb.or([
            sql<boolean>`${eb.ref('vehicle.brand')} ILIKE ${term}`,
            sql<boolean>`${eb.ref('vehicle.model')} ILIKE ${term}`,
            sql<boolean>`${eb.ref('vehicle.plate_number')} ILIKE ${term}`,
          ]),
        );
      }

      return eb.and(filters);
    };

    const totalRow = await this.db
      .selectFrom('vehicle')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where(escape)
      .executeTakeFirst();

    const total = Number(totalRow?.total ?? 0);

    const base = this.db
      .selectFrom('vehicle')
      .innerJoin('vehicle_category', 'vehicle_category.id', 'vehicle.category_id')
      .leftJoin('user', 'user.id', 'vehicle.owner_id')
      .select([
        'vehicle.id',
        'vehicle.brand',
        'vehicle.model',
        'vehicle.year',
        'vehicle.plate_number',
        'vehicle.status',
        'vehicle.daily_rate',
        'vehicle.currency_code',
        'vehicle.with_driver',
        'vehicle.owner_id',
        'vehicle.created_at',
      ])
      .select((eb) => [
        eb.ref('vehicle_category.label').as('category_label'),
        sql<string>`coalesce(${eb.ref('user.email')}, ${eb.ref('user.phone')})`.as(
          'owner_name',
        ),
        sql<number>`(
          SELECT count(*)::int FROM vehicle_document d
          WHERE d.vehicle_id = ${eb.ref('vehicle.id')}
            AND d.expires_at IS NOT NULL
            AND d.expires_at <= now()
        )`.as('expired_document_count'),
      ])
      .where(escape);

    const ordered =
      query.sort === 'newest_first'
        ? base.orderBy('vehicle.created_at', 'desc')
        : query.sort === 'price_desc'
          ? base.orderBy('vehicle.daily_rate', 'desc')
          : base.orderBy('vehicle.created_at', 'asc');

    const rows = await ordered
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage)
      .execute();

    return {
      items: rows.map((row) => AdminVehiclesService.toQueueItem(row)),
      pagination: buildPagination(query.page, query.perPage, total),
    };
  }

  // ==================================================================
  // Examen
  // ==================================================================

  async reviewDetail(id: string): Promise<VehicleReviewDetail> {
    const result = await sql<Record<string, unknown>>`
      SELECT v.*, c.label AS category_label,
             a.name AS agency_name,
             coalesce(u.email, u.phone, u.id::text) AS owner_name
      FROM vehicle v
      JOIN vehicle_category c ON c.id = v.category_id
      LEFT JOIN agency a ON a.id = v.agency_id
      LEFT JOIN "user" u ON u.id = v.owner_id
      WHERE v.id = ${id} AND v.deleted_at IS NULL
    `.execute(this.db);

    const vehicle = result.rows[0];
    if (!vehicle) throw AdminVehiclesService.notFound();

    const [documents, features, mediaCount] = await Promise.all([
      sql<Record<string, unknown>>`
        SELECT id, kind, file_url, issued_at, expires_at, status, reject_reason
        FROM vehicle_document WHERE vehicle_id = ${id} ORDER BY kind
      `.execute(this.db),
      sql<{ code: string }>`
        SELECT code FROM vehicle_feature WHERE vehicle_id = ${id} ORDER BY code
      `.execute(this.db),
      sql<{ n: number }>`
        SELECT count(*)::int AS n FROM vehicle_media WHERE vehicle_id = ${id}
      `.execute(this.db),
    ]);

    const docs = documents.rows.map((row) =>
      AdminVehiclesService.toDocument(row),
    );

    return {
      vehicle: {
        id: vehicle['id'] as string,
        brand: vehicle['brand'] as string,
        model: vehicle['model'] as string,
        year: vehicle['year'] as number,
        plateCountry: vehicle['plate_country'] as string,
        plateNumber: vehicle['plate_number'] as string,
        color: (vehicle['color'] as string | null) ?? null,
        transmission: vehicle['transmission'] as string,
        fuel: vehicle['fuel'] as string,
        seats: vehicle['seats'] as number,
        airConditioning: vehicle['air_conditioning'] as boolean,
        doors: (vehicle['doors'] as number | null) ?? null,
        luggageCapacity: (vehicle['luggage_capacity'] as number | null) ?? null,
        consumption:
          vehicle['consumption'] !== null ? Number(vehicle['consumption']) : null,
        dailyRate: vehicle['daily_rate'] as string,
        depositAmount: vehicle['deposit_amount'] as string,
        currencyCode: vehicle['currency_code'] as string,
        withDriver: vehicle['with_driver'] as boolean,
        driverIncludedInRate: vehicle['driver_included_in_rate'] as boolean,
        minDays: vehicle['min_days'] as number,
        maxKmPerDay: (vehicle['max_km_per_day'] as number | null) ?? null,
        categoryLabel: vehicle['category_label'] as string,
        status: vehicle['status'] as VehicleReviewDetail['vehicle']['status'],
        features: features.rows.map((row) => row.code),
      },
      provider: {
        type: vehicle['provider_type'] as 'agency' | 'owner',
        id: (vehicle['owner_id'] ?? vehicle['agency_id']) as string | null,
        label: (vehicle['agency_name'] ?? vehicle['owner_name']) as string,
      },
      documents: docs,
      blockers: AdminVehiclesService.blockers(docs),
      mediaCount: Number(mediaCount.rows[0]?.n ?? 0),
      createdAt: new Date(vehicle['created_at'] as Date).toISOString(),
      updatedAt: new Date(vehicle['updated_at'] as Date).toISOString(),
    };
  }

  // ==================================================================
  // Decisions sur les documents
  // ==================================================================

  /**
   * Accepte ou rejette un document.
   *
   * L'expiration est recalculee a chaque lecture : un document stocke
   * comme valide mais dont la date est passee apparait `expired`, et
   * l'administrateur doit pouvoir le prolonger.
   */
  async decideDocument(
    vehicleId: string,
    decision: ReviewDocumentDecision,
    admin: AuthenticatedUser,
  ): Promise<VehicleReviewDetail> {
    await this.assertVehicleExists(vehicleId);

    const existing = await sql<{ id: string }>`
      SELECT id FROM vehicle_document
      WHERE id = ${decision.documentId} AND vehicle_id = ${vehicleId}
    `.execute(this.db);

    if (existing.rows.length === 0) {
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document introuvable pour ce vehicule.',
      });
    }

    const status = decision.accept ? 'valid' : 'rejected';

    await sql`
      UPDATE vehicle_document
      SET status = ${status},
          reject_reason = ${decision.accept ? null : (decision.rejectReason ?? null)},
          reviewed_by = ${admin.id},
          reviewed_at = now()
      WHERE id = ${decision.documentId}
    `.execute(this.db);

    await this.audit(admin, 'vehicle.document_reviewed', vehicleId, {
      documentId: decision.documentId,
      status,
      reason: decision.rejectReason ?? null,
    });

    if (!decision.accept) {
      // Le fournisseur doit savoir quel document corriger.
      const owner = await this.ownerOf(vehicleId);
      await this.notifications.queueCritical(
        owner,
        'vehicle.document_rejected',
        `Document rejete sur votre vehicule : ${decision.rejectReason ?? 'non conforme'}`,
        { vehicleId, documentId: decision.documentId },
      );
    }

    return this.reviewDetail(vehicleId);
  }

  // ==================================================================
  // Decision globale
  // ==================================================================

  /**
   * Valide ou refuse un vehicule.
   *
   * La validation est refusee si un document obligatoire est absent,
   * rejete ou expire. L'administrateur ne peut pas publier un vehicule
   * dont la carte grise expire, meme s'il le souhaite : c'est la regle
   * qui protege le client final.
   */
  async decide(
    vehicleId: string,
    decision: ReviewDecision,
    admin: AuthenticatedUser,
  ): Promise<{ status: string; decisionAt: string }> {
    const vehicle = await this.loadForDecision(vehicleId);

    if (decision.action === 'reject') {
      await sql`
        UPDATE vehicle SET status = 'rejected' WHERE id = ${vehicleId}
      `.execute(this.db);

      await this.audit(admin, 'vehicle.rejected', vehicleId, {
        reason: decision.reason ?? null,
        internalNote: decision.internalNote ?? null,
      });

      await this.notifications.queueCritical(
        vehicle.ownerId,
        'vehicle.rejected',
        `Votre vehicule ${vehicle.plate} n a pas ete valide : ${decision.reason}`,
        { vehicleId, reason: decision.reason ?? null },
      );

      return { status: 'rejected', decisionAt: new Date().toISOString() };
    }

    const blockers = await this.currentBlockers(vehicleId);

    if (blockers.length > 0) {
      throw new ConflictException({
        code: 'PUBLICATION_BLOCKED',
        message:
          'Publication impossible : des documents obligatoires sont manquants, ' +
          'rejetes ou expires.',
        details: { blockers },
      });
    }

    await sql`
      UPDATE vehicle
      SET status = 'published', published_at = now()
      WHERE id = ${vehicleId}
    `.execute(this.db);

    await this.audit(admin, 'vehicle.approved', vehicleId, {
      internalNote: decision.internalNote ?? null,
      previously: vehicle.status,
    });

    await this.notifications.queueCritical(
      vehicle.ownerId,
      'vehicle.published',
      `Votre vehicule ${vehicle.plate} est desormais visible sur la plateforme.`,
      { vehicleId },
    );

    return { status: 'published', decisionAt: new Date().toISOString() };
  }

  // ==================================================================
  // Helpers
  // ==================================================================

  private async assertVehicleExists(id: string): Promise<void> {
    const found = await sql<{ one: number }>`
      SELECT 1 AS one FROM vehicle WHERE id = ${id} AND deleted_at IS NULL
    `.execute(this.db);

    if (found.rows.length === 0) throw AdminVehiclesService.notFound();
  }

  private async loadForDecision(
    id: string,
  ): Promise<{ status: string; plate: string; ownerId: string | null }> {
    const result = await sql<{
      status: string;
      plate_number: string;
      owner_id: string | null;
    }>`
      SELECT status, plate_number, owner_id FROM vehicle
      WHERE id = ${id} AND deleted_at IS NULL
    `.execute(this.db);

    const row = result.rows[0];
    if (!row) throw AdminVehiclesService.notFound();

    if (row['status'] === 'draft') {
      throw new BadRequestException({
        code: 'NOT_SUBMITTED',
        message: 'Ce vehicule n a pas encore ete soumis a validation.',
      });
    }

    return {
      status: row.status,
      plate: row.plate_number,
      ownerId: row.owner_id ?? null,
    };
  }

  /** Documents actuellement bloquants pour une publication. */
  private async currentBlockers(vehicleId: string): Promise<string[]> {
    const documents = await sql<{
      kind: string;
      expires_at: string | null;
      status: string;
    }>`
      SELECT kind, expires_at, status FROM vehicle_document
      WHERE vehicle_id = ${vehicleId}
    `.execute(this.db);

    const byKind = new Map(
      documents.rows.map((row) => [
        row.kind,
        { expiresAt: row.expires_at ?? null, status: row.status },
      ]),
    );

    const blockers: string[] = [];

    for (const kind of REQUIRED_DOCUMENTS) {
      const doc = byKind.get(kind);

      if (!doc) {
        blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} manquant`);
        continue;
      }

      if (doc.status === 'rejected') {
        blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} rejete`);
        continue;
      }

      if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) {
        blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} expire`);
        continue;
      }

      if (doc.status !== 'valid') {
        blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} non valide`);
      }
    }

    return blockers;
  }

  private async ownerOf(vehicleId: string): Promise<string | null> {
    const result = await sql<{ owner_id: string | null }>`
      SELECT owner_id FROM vehicle WHERE id = ${vehicleId}
    `.execute(this.db);
    return result.rows[0]?.owner_id ?? null;
  }

  /**
   * Journalise la decision (CDCS 12.5).
   *
   * `before` et `after` sont conserves : une decision d arbitrage doit
   * pouvoir etre rejouee ou auditee des mois plus tard.
   */
  private async audit(
    admin: AuthenticatedUser,
    action: string,
    vehicleId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await sql`
      INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, after)
      VALUES (${admin.id}, ${sql.raw(`ARRAY[${admin.roles.map((r) => `'${r}'`).join(',')}]`)}, ${action}, 'vehicle', ${vehicleId}, ${JSON.stringify(data)}::jsonb)
    `.execute(this.db);
  }

  /** Blocages calcules a partir d'une liste de documents deja charges. */
  private static blockers(documents: ReviewDocument[]): string[] {
    const byKind = new Map(documents.map((doc) => [doc.kind, doc]));
    const blockers: string[] = [];

    for (const kind of REQUIRED_DOCUMENTS) {
      const doc = byKind.get(kind);

      if (!doc) {
        blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} manquant`);
        continue;
      }

      switch (doc.effectiveStatus) {
        case 'expired':
          blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} expire`);
          break;
        case 'rejected':
          blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} rejete`);
          break;
        case 'pending':
          blockers.push(`${AdminVehiclesService.documentLabel(kind) ?? kind} en attente de validation`);
          break;
        default:
          break;
      }
    }

    return blockers;
  }

  /**
   * Statut effectif d'un document : l'expiration prime sur le statut
   * stocke, car une date passee sans action humaine doit suffire a
   * bloquer la publication.
   */
  private static toDocument(row: Record<string, unknown>): ReviewDocument {
    const storedStatus = row['status'] as ReviewDocument['storedStatus'];
    const expiresAt = (row['expires_at'] as string | Date | null) ?? null;

    const effectiveStatus: ReviewDocument['effectiveStatus'] =
      expiresAt && new Date(expiresAt).getTime() <= Date.now()
        ? 'expired'
        : storedStatus;

    return {
      id: row['id'] as string,
      kind: row['kind'] as ReviewDocument['kind'],
      fileUrl: row['file_url'] as string,
      issuedAt: (row['issued_at'] as Date | null)?.toISOString() ?? null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      effectiveStatus,
      storedStatus,
      rejectReason: (row['reject_reason'] as string | null) ?? null,
    };
  }

  private static toQueueItem(row: Record<string, unknown>): ReviewQueueItem {
    return {
      id: row['id'] as string,
      brand: row['brand'] as string,
      model: row['model'] as string,
      year: row['year'] as number,
      plateNumber: row['plate_number'] as string,
      status: row['status'] as ReviewQueueItem['status'],
      categoryLabel: row['category_label'] as string,
      dailyRate: row['daily_rate'] as string,
      currencyCode: row['currency_code'] as string,
      withDriver: row['with_driver'] as boolean,
      ownerId: (row['owner_id'] as string | null) ?? null,
      ownerName: (row['owner_name'] as string | null) ?? null,
      expiredDocumentCount: Number(row['expired_document_count'] ?? 0),
      submittedAt: null,
      createdAt: new Date(row['created_at'] as Date).toISOString(),
    };
  }

  /**
   * Nombre de documents dont l'expiration est passee.
   *
   * Convention de nommage du CDC : « carte grise » plutot que
   * « registration », y compris dans les messages destines au
   * fournisseur. La traduction est faite ici, a un seul endroit.
   */
  private static documentLabel(kind: string): string {
    // La valeur de repli est `kind` : un type de document inconnu reste
    // ainsi affichable plutot que masque.
    return DOCUMENT_LABELS[kind] ?? kind;
  }

  private static notFound(): NotFoundException {
    return new NotFoundException({
      code: 'VEHICLE_NOT_FOUND',
      message: 'Vehicule introuvable.',
    });
  }
}