import {
  cents,
  type BookingDetail,
  type BookingHistoryEntry,
  type BookingSummary,
} from '@adkcars/contracts';

import type {
  BookingHistoryRow,
  BookingJoinedRow,
  BookingRow,
} from './booking.types';

/**
 * Restriction d'acces a une reservation.
 *
 * La securite ne repose pas sur le controleur : chaque lecture passe par
 * `canView`, qui rejoue la regle de propriete. Un oubli dans une route
 * ne peut donc pas exposer une reservation (CDCS 12.3).
 */
export interface BookingAccess {
  /** L'acteur est-il concerne par cette reservation ? */
  involved: boolean;
  /** L'acteur est-il administrateur ? */
  admin: boolean;
  /** L'acteur est-il le fournisseur, agence ou proprietaire ? */
  provider: boolean;
}

export function accessFor(
  row: Pick<BookingRow, 'client_id' | 'provider_type' | 'agency_id' | 'owner_id'>,
  userId: string,
  isAdmin: boolean,
): BookingAccess {
  const provider =
    (row.provider_type === 'agency' && row.agency_id === userId) ||
    (row.provider_type === 'owner' && row.owner_id === userId);

  return {
    involved: row.client_id === userId || provider,
    admin: isAdmin,
    provider,
  };
}

export function canView(access: BookingAccess): boolean {
  return access.involved || access.admin;
}

/**
 * Acteurs autorises a faire une transition.
 *
 * Se distingue de `allowedTransitionsForActor`, qui n'est qu'un confort
 * d'AFFICHAGE : ici, une mauvaise requete doit etre refusee.
 */
export function canActOn(access: BookingAccess): boolean {
  return access.involved || access.admin;
}

/** Acteur tel que la machine a etats l'attend. */
export function actorOf(access: BookingAccess): 'client' | 'provider' | 'admin' {
  if (access.admin) return 'admin';
  return access.provider ? 'provider' : 'client';
}

export function toSummary(row: BookingJoinedRow): BookingSummary {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    // Chaines d'entiers, pas de `number` : un total de location peut
    // depasser 2^53, et le BigInt de la base serait alors deja arrondi
    // a la conversion.
    total: cents(row.total_amount).toString(),
    deposit: cents(row.deposit_amount).toString(),
    currencyCode: row.currency_code,
    vehicle: {
      id: row.vehicle_id,
      brand: row.v_brand,
      model: row.v_model,
      plateNumber: row.v_plate_number,
    },
    counterpart: {
      providerType: row.cp_type,
      name: row.cp_name,
    },
    createdAt: row.created_at,
  };
}

export function toDetail(
  row: BookingJoinedRow,
  allowedTransitions: readonly string[],
  history: BookingHistoryRow[],
): BookingDetail {
  return {
    ...toSummary(row),
    pricingSnapshot: row.pricing_snapshot,
    isOneWay: row.is_one_way,
    customerNotes: row.customer_notes,
    allowedTransitions: [...allowedTransitions] as BookingDetail['allowedTransitions'],
    version: row.version,
    confirmedAt: row.confirmed_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    history: history.map(toHistoryEntry),
  };
}

export function toHistoryEntry(row: BookingHistoryRow): BookingHistoryEntry {
  return {
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorId: row.actor_id,
    reason: row.reason,
    at: row.at,
  };
}
