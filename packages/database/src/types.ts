/**
 * Types Kysely reflétant exactement le schema SQL
 * `packages/database/migrations/0001_init.sql`.
 *
 * Toute divergence entre ce fichier et la migration est un bug : le
 * regle "une seule source de verite" s'applique aussi ici.
 *
 * Convention sur les types (CDCS 9.2) :
 *   - `bigint` (montants)  -> `MoneyInt`, choisi en `string | number`
 *   - `timestamptz`        -> `Timestamp`, choisi en `Date | string`
 *   - UUID                 -> `Uuid`, choisi en `string`
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

// ---------------------------------------------------------------------------
// Types utilitaires
// ---------------------------------------------------------------------------

/** UUID : toujours une chaine cote JS, jamais un nombre. */
export type Uuid = ColumnType<string, string | undefined, string>;

/** Identifiant a valeur par defaut en base (gen_random_uuid()). */
export type UuidPk = ColumnType<string, string | undefined, string>;

/**
 * Montant en centimes. Le driver `pg` renvoie les `bigint` sous forme de
 * chaine : le type le reflete pour eviter une perte de precision silencieuse
 * sur les montants (CDCS 4.3).
 */
export type MoneyInt = ColumnType<string, string | number | undefined, string | number>;

/** Pourcentage exprimes en fraction (0.1200 = 12 %). */
export type Ratio = ColumnType<string, string | number | undefined, string | number>;

/** Date-heure UTC. Stockee en timestamptz, exposee en Date ou chaine ISO. */
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** Date-heure UTC a creation automatique en base. */
export type CreatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

/** Date-heure UTC modifiable, geree par le trigger `set_updated_at`. */
export type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

/** Suppression logique (CDCS 8.7). */
export type DeletedAt = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

/** Nombre optimiste de versions, incremente a chaque ecriture (CDCS 9.2). */
export type Version = ColumnType<number, number | undefined, number>;

export type Json = ColumnType<
  unknown,
  string | Record<string, unknown> | undefined,
  string | Record<string, unknown>
>;

export type TextArray = ColumnType<string[], string[] | undefined, string[]>;

export type Nullable<T> = T | null;

// ---------------------------------------------------------------------------
// Referentiels
// ---------------------------------------------------------------------------

export interface CountryTable {
  id: UuidPk;
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  phone_code: string;
  /** ISO 4217. */
  default_currency: string;
  default_locale: Generated<string>;
  timezone: Generated<string>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
}

export interface CurrencyTable {
  /** ISO 4217. */
  code: string;
  name: string;
  symbol: string;
  minor_units: Generated<number>;
  is_active: Generated<boolean>;
}

export interface LocationTable {
  id: UuidPk;
  country_code: string;
  parent_id: Nullable<Uuid>;
  type: 'country' | 'city' | 'commune' | 'district';
  name: string;
  slug: string;
  lat: Generated<string | null>;
  lng: Generated<string | null>;
  geocoded_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
}

// ---------------------------------------------------------------------------
// Identite et droits
// ---------------------------------------------------------------------------

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deleted';
export type UserRole = 'client' | 'owner' | 'agency' | 'driver' | 'admin';

export interface UserTable {
  id: UuidPk;
  email: Nullable<string>;
  /** E.164, ex. +2250700000000. */
  phone: Nullable<string>;
  password_hash: Nullable<string>;
  status: Generated<UserStatus>;
  roles: Generated<string[]>;
  locale: Generated<string>;
  preferred_channel: Generated<'email' | 'sms' | 'push' | 'whatsapp'>;
  email_verified_at: Nullable<Timestamp>;
  phone_verified_at: Nullable<Timestamp>;
  last_login_at: Nullable<Timestamp>;
  last_login_ip: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
}

export interface AuthRefreshTokenTable {
  id: UuidPk;
  user_id: Uuid;
  /**empreinte du token : le token en clair n'est JAMAIS stocke (CDCS 12.2). */
  token_hash: string;
  device_label: Nullable<string>;
  ip: Nullable<string>;
  user_agent: Nullable<string>;
  issued_at: CreatedAt;
  expires_at: Timestamp;
  revoked_at: Nullable<Timestamp>;
  replaced_by_id: Nullable<Uuid>;
}

export type OtpPurpose = 'phone_verification' | 'login' | 'password_reset' | '2fa';

export interface AuthOtpTable {
  id: UuidPk;
  user_id: Uuid;
  purpose: OtpPurpose;
  code_hash: string;
  attempts: Generated<number>;
  expires_at: Timestamp;
  consumed_at: Nullable<Timestamp>;
  created_at: CreatedAt;
}

// ---------------------------------------------------------------------------
// Fournisseurs
// ---------------------------------------------------------------------------

export type PlanKey = 'starter' | 'business' | 'premium' | 'enterprise';

export interface PlanTable {
  id: UuidPk;
  key: PlanKey;
  label: string;
  /** -1 signifie illimite. */
  vehicle_limit: number;
  member_limit: Generated<number>;
  commission_rate: Ratio;
  price_amount: MoneyInt;
  currency_code: Generated<string>;
  features: Json;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type AgencyStatus = 'pending' | 'active' | 'suspended' | 'rejected';

export interface AgencyTable {
  id: UuidPk;
  name: string;
  slug: string;
  legal_name: Nullable<string>;
  /** Registre du commerce du Commerce. */
  rccm: Nullable<string>;
  /** Identifiant fiscal unique. */
  ifu: Nullable<string>;
  plan_id: Nullable<Uuid>;
  commission_rate: Nullable<Ratio>;
  city_id: Nullable<Uuid>;
  address: Nullable<string>;
  phone: Nullable<string>;
  email: Nullable<string>;
  logo_url: Nullable<string>;
  status: Generated<AgencyStatus>;
  rating: Nullable<Ratio>;
  ratings_count: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
  version: Version;
}

export interface SubscriptionTable {
  id: UuidPk;
  agency_id: Uuid;
  plan_id: Uuid;
  status: Generated<'active' | 'past_due' | 'cancelled' | 'expired'>;
  started_at: Timestamp;
  renews_at: Timestamp;
  cancelled_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AgencyMemberTable {
  id: UuidPk;
  agency_id: Uuid;
  user_id: Uuid;
  role: 'owner' | 'manager' | 'agent' | 'accountant';
  permissions: Generated<string[]>;
  joined_at: CreatedAt;
}

export interface DriverTable {
  id: UuidPk;
  user_id: Uuid;
  agency_id: Nullable<Uuid>;
  license_number: Nullable<string>;
  license_expiry: Nullable<string>;
  rating: Nullable<Ratio>;
  ratings_count: Generated<number>;
  status: Generated<'pending' | 'active' | 'suspended' | 'rejected'>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
  version: Version;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface VehicleCategoryTable {
  id: UuidPk;
  slug: string;
  label: string;
  attributes_schema: Json;
  icon_url: Nullable<string>;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export type VehicleStatus = 'draft' | 'in_review' | 'published' | 'rejected' | 'archived';
export type Transmission = 'manual' | 'automatic';
export type Fuel = 'petrol' | 'diesel' | 'hybrid' | 'electric' | 'lpg';
export type ProviderType = 'agency' | 'owner';

export interface VehicleTable {
  id: UuidPk;
  provider_type: ProviderType;
  agency_id: Nullable<Uuid>;
  owner_id: Nullable<Uuid>;
  category_id: Uuid;
  brand: string;
  model: string;
  year: number;
  plate_country: Generated<string>;
  plate_number: string;
  color: Nullable<string>;
  transmission: Transmission;
  fuel: Fuel;
  seats: number;
  air_conditioning: Generated<boolean>;
  doors: Nullable<number>;
  luggage_capacity: Nullable<number>;
  consumption: Nullable<Ratio>;
  daily_rate: MoneyInt;
  deposit_amount: MoneyInt;
  currency_code: Generated<string>;
  with_driver: Generated<boolean>;
  driver_included_in_rate: Generated<boolean>;
  min_days: Generated<number>;
  max_km_per_day: Nullable<number>;
  location_id: Nullable<Uuid>;
  status: Generated<VehicleStatus>;
  published_at: Nullable<Timestamp>;
  rating: Nullable<Ratio>;
  ratings_count: Generated<number>;
  /** Maintenu par le trigger `vehicle_search_vector`. */
  search_vector: Generated<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
  version: Version;
}

export interface VehicleFeatureTable {
  id: UuidPk;
  vehicle_id: Uuid;
  code: string;
  label: string;
}

export interface VehicleMediaTable {
  id: UuidPk;
  vehicle_id: Uuid;
  kind: 'photo' | 'video';
  url: string;
  width: Nullable<number>;
  height: Nullable<number>;
  bytes: Nullable<MoneyInt>;
  sort_order: Generated<number>;
  is_cover: Generated<boolean>;
  created_at: CreatedAt;
}

export type VehicleDocumentKind =
  | 'registration'
  | 'insurance'
  | 'rca'
  | 'technical_control'
  | 'agency_licence';

export interface VehicleDocumentTable {
  id: UuidPk;
  vehicle_id: Uuid;
  kind: VehicleDocumentKind;
  file_url: string;
  issued_at: Nullable<string>;
  expires_at: Nullable<string>;
  status: Generated<'pending' | 'valid' | 'expired' | 'rejected'>;
  reviewed_by: Nullable<Uuid>;
  reviewed_at: Nullable<Timestamp>;
  reject_reason: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AvailabilityTable {
  id: UuidPk;
  vehicle_id: Uuid;
  start_at: Timestamp;
  end_at: Timestamp;
  type: 'available' | 'blocked' | 'maintenance';
  reason: Nullable<string>;
  created_by: Nullable<Uuid>;
  created_at: CreatedAt;
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

export type BookingStatus =
  | 'draft'
  | 'awaiting_payment'
  | 'paid'
  | 'in_progress'
  | 'late_return'
  | 'completed'
  | 'disputed'
  | 'cancelled_client'
  | 'cancelled_provider'
  | 'expired'
  | 'resolved_client'
  | 'resolved_provider'
  | 'resolved_split'
  | 'closed';

export interface BookingTable {
  id: UuidPk;
  /** Reference courte communiquee au client et aux paiements. */
  reference: string;
  client_id: Uuid;
  provider_type: ProviderType;
  agency_id: Nullable<Uuid>;
  owner_id: Nullable<Uuid>;
  vehicle_id: Uuid;
  start_at: Timestamp;
  end_at: Timestamp;
  pickup_location_id: Nullable<Uuid>;
  return_location_id: Nullable<Uuid>;
  is_one_way: Generated<boolean>;
  status: Generated<BookingStatus>;
  /**
   * Devis fige au moment de la creation. Le total ne peut jamais etre
   * recalcule apres encaissement (CDCS 7.5).
   */
  pricing_snapshot: Json;
  currency_code: Generated<string>;
  total_amount: MoneyInt;
  deposit_amount: MoneyInt;
  /** Taux de commission fige pour la duree de la location (CDCS 8.5). */
  commission_rate: Nullable<Ratio>;
  customer_notes: Nullable<string>;
  confirmed_at: Nullable<Timestamp>;
  started_at: Nullable<Timestamp>;
  ended_at: Nullable<Timestamp>;
  cancelled_at: Nullable<Timestamp>;
  cancel_reason: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  version: Version;
}

export interface BookingStatusHistoryTable {
  id: UuidPk;
  booking_id: Uuid;
  from_status: Nullable<string>;
  to_status: string;
  actor_id: Nullable<Uuid>;
  reason: Nullable<string>;
  ip: Nullable<string>;
  at: Timestamp;
}

// ---------------------------------------------------------------------------
// Paiement
// ---------------------------------------------------------------------------

export type PaymentKind = 'rental' | 'deposit' | 'penalty' | 'extra_charge' | 'subscription';

export interface PaymentTable {
  id: UuidPk;
  booking_id: Uuid;
  /** Cle de l'implementation d'operateur (CDCS 14.2). */
  provider_key: string;
  method: 'mobile_money' | 'card' | 'cash' | 'transfer';
  kind: Generated<PaymentKind>;
  amount: MoneyInt;
  currency_code: Generated<string>;
  status: Generated<
    'pending' | 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refunded'
  >;
  external_ref: Nullable<string>;
  raw_payload: Nullable<Json>;
  /** Garantit qu'un webhook repete ne debite jamais deux fois (CDCS 12.6). */
  idempotency_key: Nullable<string>;
  failure_code: Nullable<string>;
  failure_reason: Nullable<string>;
  paid_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface RefundTable {
  id: UuidPk;
  payment_id: Uuid;
  kind: 'refund' | 'deposit_release' | 'deposit_capture' | 'chargeback';
  amount: MoneyInt;
  currency_code: Generated<string>;
  status: Generated<'pending' | 'succeeded' | 'failed'>;
  reason: string;
  requested_by: Nullable<Uuid>;
  external_ref: Nullable<string>;
  created_at: CreatedAt;
  processed_at: Nullable<Timestamp>;
}

export interface PayoutTable {
  id: UuidPk;
  provider_type: ProviderType;
  agency_id: Nullable<Uuid>;
  owner_id: Nullable<Uuid>;
  period_start: string;
  period_end: string;
  gross_amount: MoneyInt;
  commission_amount: MoneyInt;
  tax_amount: MoneyInt;
  net_amount: MoneyInt;
  currency_code: Generated<string>;
  status: Generated<'draft' | 'approved' | 'processing' | 'paid' | 'failed'>;
  paid_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// ---------------------------------------------------------------------------
// Contrat, remise, litige
// ---------------------------------------------------------------------------

export interface ContractTable {
  id: UuidPk;
  booking_id: Uuid;
  version: Generated<number>;
  pdf_url: Nullable<string>;
  checksum: Nullable<string>;
  status: Generated<
    'generated' | 'sent' | 'partially_signed' | 'signed' | 'void' | 'expired'
  >;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SignatureTable {
  id: UuidPk;
  contract_id: Uuid;
  signer_id: Nullable<Uuid>;
  signer_role: 'client' | 'provider' | 'witness';
  signer_name: string;
  method: 'otp' | 'drawn' | 'typed';
  /** Empreinte du document signe : garantit l'integrite (CDCS 12.5). */
  document_hash: string;
  ip: Nullable<string>;
  signed_at: Timestamp;
}

export interface HandoverTable {
  id: UuidPk;
  booking_id: Uuid;
  kind: 'pickup' | 'return';
  performed_by: Nullable<Uuid>;
  mileage: Nullable<number>;
  fuel_level: Nullable<number>;
  photos: TextArray;
  notes: Nullable<string>;
  signatures: TextArray;
  performed_at: Timestamp;
}

export interface DamageReportTable {
  id: UuidPk;
  booking_id: Uuid;
  handover_id: Nullable<Uuid>;
  reported_by: Nullable<Uuid>;
  description: string;
  photos: TextArray;
  estimated_amount: Nullable<MoneyInt>;
  currency_code: Generated<string>;
  status: Generated<
    'reported' | 'acknowledged' | 'contested' | 'accepted' | 'rejected' | 'resolved'
  >;
  resolution: Nullable<string>;
  resolved_by: Nullable<Uuid>;
  resolved_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface DisputeTable {
  id: UuidPk;
  booking_id: Uuid;
  opened_by: Uuid;
  reason: string;
  description: Nullable<string>;
  evidence: TextArray;
  status: Generated<
    'open' | 'under_review' | 'resolved' | 'closed_without_action' | 'closed_by_timeout'
  >;
  outcome: Nullable<'client' | 'provider' | 'split' | 'none'>;
  resolution: Nullable<string>;
  assigned_to: Nullable<Uuid>;
  resolved_by: Nullable<Uuid>;
  created_at: CreatedAt;
  /** Delai de 48 h pour produire les pieces (CDCS 8.3). */
  evidence_due_at: Timestamp;
  resolved_at: Nullable<Timestamp>;
  updated_at: UpdatedAt;
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export interface ReviewTable {
  id: UuidPk;
  /** Unicite garantie en base : un avis par location (CDCS 9.3). */
  booking_id: Uuid;
  author_id: Uuid;
  vehicle_id: Uuid;
  rating: number;
  comment: Nullable<string>;
  status: Generated<'pending' | 'published' | 'hidden' | 'deleted'>;
  is_reported: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  deleted_at: DeletedAt;
}

export interface ReviewReportTable {
  id: UuidPk;
  review_id: Uuid;
  reporter_id: Uuid;
  reason: string;
  status: Generated<'open' | 'upheld' | 'dismissed'>;
  resolved_by: Nullable<Uuid>;
  created_at: CreatedAt;
  resolved_at: Nullable<Timestamp>;
}

export interface ReviewResponseTable {
  id: UuidPk;
  review_id: Uuid;
  author_id: Uuid;
  body: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

export interface NotificationPreferenceTable {
  user_id: Uuid;
  event: string;
  channels: Generated<string[]>;
}

export interface NotificationTable {
  id: UuidPk;
  user_id: Uuid;
  event: string;
  channel: 'email' | 'sms' | 'push' | 'whatsapp';
  priority: Generated<number>;
  status: Generated<'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'bounced'>;
  subject: Nullable<string>;
  body: string;
  payload: Json;
  provider_key: Nullable<string>;
  external_ref: Nullable<string>;
  error: Nullable<string>;
  attempts: Generated<number>;
  scheduled_at: Timestamp;
  sent_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ConversationTable {
  id: UuidPk;
  booking_id: Nullable<Uuid>;
  subject: Nullable<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ConversationParticipantTable {
  conversation_id: Uuid;
  user_id: Uuid;
  last_read_at: Nullable<Timestamp>;
  joined_at: CreatedAt;
}

export interface MessageTable {
  id: UuidPk;
  conversation_id: Uuid;
  sender_id: Uuid;
  body: Nullable<string>;
  attachments: TextArray;
  location: Nullable<Json>;
  sent_at: Timestamp;
  deleted_at: DeletedAt;
}

// ---------------------------------------------------------------------------
// Commercial et back-office
// ---------------------------------------------------------------------------

export interface CouponTable {
  id: UuidPk;
  code: string;
  kind: 'percent' | 'amount';
  /** 1000 = 10 %, ou 5000 = 50,00 selon le montant. */
  value: MoneyInt;
  scope: Generated<'platform' | 'category' | 'agency' | 'vehicle'>;
  target_id: Nullable<Uuid>;
  min_amount: MoneyInt;
  max_uses: Nullable<number>;
  used_count: Generated<number>;
  valid_from: Timestamp;
  valid_to: Nullable<Timestamp>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface CmsPageTable {
  id: UuidPk;
  slug: string;
  locale: Generated<string>;
  title: string;
  body: string;
  seo_title: Nullable<string>;
  seo_description: Nullable<string>;
  status: Generated<'draft' | 'published' | 'archived'>;
  published_at: Nullable<Timestamp>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface FaqItemTable {
  id: UuidPk;
  category: Nullable<string>;
  question: string;
  answer: string;
  locale: Generated<string>;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BannerTable {
  id: UuidPk;
  placement: string;
  title: Nullable<string>;
  image_url: string;
  link_url: Nullable<string>;
  locale: Generated<string>;
  starts_at: Nullable<Timestamp>;
  ends_at: Nullable<Timestamp>;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SettingTable {
  key: string;
  value: Json;
  group_name: Generated<string>;
  is_secret: Generated<boolean>;
  updated_by: Nullable<Uuid>;
  updated_at: UpdatedAt;
}

/** Journal d'audit : ajout seul, jamais modifie (CDCS 12.5). */
export interface AuditLogTable {
  id: Generated<string>;
  actor_id: Nullable<Uuid>;
  actor_role: Nullable<string>;
  action: string;
  entity: string;
  entity_id: Nullable<Uuid>;
  before: Nullable<Json>;
  after: Nullable<Json>;
  ip: Nullable<string>;
  user_agent: Nullable<string>;
  at: Timestamp;
}

// ---------------------------------------------------------------------------
// Interface Kysely
// ---------------------------------------------------------------------------

export interface Database {
  country: CountryTable;
  currency: CurrencyTable;
  location: LocationTable;

  user: UserTable;
  auth_refresh_token: AuthRefreshTokenTable;
  auth_otp: AuthOtpTable;

  plan: PlanTable;
  agency: AgencyTable;
  subscription: SubscriptionTable;
  agency_member: AgencyMemberTable;
  driver: DriverTable;

  vehicle_category: VehicleCategoryTable;
  vehicle: VehicleTable;
  vehicle_feature: VehicleFeatureTable;
  vehicle_media: VehicleMediaTable;
  vehicle_document: VehicleDocumentTable;
  availability: AvailabilityTable;

  booking: BookingTable;
  booking_status_history: BookingStatusHistoryTable;

  payment: PaymentTable;
  refund: RefundTable;
  payout: PayoutTable;

  contract: ContractTable;
  signature: SignatureTable;
  handover: HandoverTable;
  damage_report: DamageReportTable;
  dispute: DisputeTable;

  review: ReviewTable;
  review_report: ReviewReportTable;
  review_response: ReviewResponseTable;

  notification_preference: NotificationPreferenceTable;
  notification: NotificationTable;
  conversation: ConversationTable;
  conversation_participant: ConversationParticipantTable;
  message: MessageTable;

  coupon: CouponTable;
  cms_page: CmsPageTable;
  faq_item: FaqItemTable;
  banner: BannerTable;
  setting: SettingTable;
  audit_log: AuditLogTable;
}

// ---------------------------------------------------------------------------
// Raccourcis
// ---------------------------------------------------------------------------

/** Ligne lisible depuis la base. */
export type Select<T, K extends keyof T & string> = Selectable<T[K]>;

/** Ligne a inserer : les colonnes avec valeur par defaut sont optionnelles. */
export type New<T, K extends keyof T & string> = Insertable<T[K]>;

/** Ligne a modifier. */
export type Patch<T, K extends keyof T & string> = Updateable<T[K]>;

export type Vehicle = Selectable<VehicleTable>;
export type Booking = Selectable<BookingTable>;
export type Agency = Selectable<AgencyTable>;
export type User = Selectable<UserTable>;
export type Payment = Selectable<PaymentTable>;
export type Plan = Selectable<PlanTable>;