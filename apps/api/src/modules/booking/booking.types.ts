import type { BookingStatus, ProviderType } from '@adkcars/database';

/** Forme des colonnes utiles de `booking`. */
export interface BookingRow {
  id: string;
  reference: string;
  client_id: string;
  provider_type: ProviderType;
  agency_id: string | null;
  owner_id: string | null;
  vehicle_id: string;
  start_at: Date;
  end_at: Date;
  pickup_location_id: string | null;
  return_location_id: string | null;
  is_one_way: boolean;
  status: BookingStatus;
  pricing_snapshot: Record<string, unknown>;
  currency_code: string;
  total_amount: string;
  deposit_amount: string;
  commission_rate: string | null;
  commission_source: string | null;
  customer_notes: string | null;
  confirmed_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

/** Colonnes du vehicule et de son proprietaire, jointes a la reservation. */
export interface BookingJoinedRow extends BookingRow {
  // vehicule
  v_brand: string;
  v_model: string;
  v_plate_number: string;
  v_daily_rate: string;
  v_deposit_amount: string;
  // contrepartie
  cp_name: string;
  cp_type: ProviderType;
}

export interface BookingHistoryRow {
  id: string;
  from_status: BookingStatus | null;
  to_status: BookingStatus;
  actor_id: string | null;
  reason: string | null;
  at: Date;
}

/**
 * Taux de commission retenu pour un partenaire, et sa provenance.
 *
 * La provenance est conservée : sans elle, un litige sur un pourcentage
 * demanderait de reconstituer l'historique des formules, impossible après
 * coup (CDCS 8.5).
 */
export interface ResolvedCommission {
  rate: number;
  source: 'partner_override' | 'plan' | 'platform_default';
}

export interface CommissionCandidateRow {
  partner_rate: string | null;
  plan_rate: string | null;
  platform_rate: string | null;
}
