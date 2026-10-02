-- ===================================================================
-- AdkCars CI - 0001 : socle referentiel et identite
--
-- Ce fichier est la SOURCE DE VERITE du schema.
-- packages/database/src/types.ts doit en rester le reflet exact.
--
-- PRE-REQUIS : les migrations sont executees avec un role disposant
-- du droit CREATE EXTENSION (DIRECT_DATABASE_URL). L'application, elle,
-- ne dispose que d'un role restreint (DATABASE_URL) : CDCS 12.1,
-- principe du moindre privilege.
-- ===================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===================================================================
-- 1. REFERENTIELS ET MULTI-PAYS  (CDCS 9, 10.6)
-- ===================================================================

CREATE TABLE country (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             char(2)      NOT NULL UNIQUE,      -- ISO 3166-1 alpha-2
  name             text         NOT NULL,
  phone_code       text         NOT NULL,             -- ex. +225
  default_currency char(3)      NOT NULL,             -- ISO 4217
  default_locale   text         NOT NULL DEFAULT 'fr',
  timezone         text         NOT NULL DEFAULT 'UTC',
  is_active        boolean      NOT NULL DEFAULT false,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE currency (
  code         char(3) PRIMARY KEY,                   -- ISO 4217
  name         text    NOT NULL,
  symbol       text    NOT NULL,
  minor_units  smallint NOT NULL DEFAULT 0,           -- XOF: 0 decimal
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE location (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code char(2)     NOT NULL REFERENCES country (code),
  parent_id    uuid        REFERENCES location (id) ON DELETE RESTRICT,
  type         text        NOT NULL CHECK (type IN ('country', 'city', 'commune', 'district')),
  name         text        NOT NULL,
  slug         text        NOT NULL,
  lat          numeric(9, 6),
  lng          numeric(9, 6),
  -- geocodage memorise pour eviter de repayer l'API cartographique
  -- (CDCS 14.4 : le cout cartographique est un risque financier)
  geocoded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT location_unique_slug_per_country UNIQUE (country_code, slug),
  -- une commune ne peut pas etre sa propre parente
  CONSTRAINT location_no_self_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX location_country_idx ON location (country_code);
CREATE INDEX location_parent_idx  ON location (parent_id);
CREATE INDEX location_type_idx    ON location (type);
CREATE INDEX location_name_trgm   ON location USING gin (name gin_trgm_ops);

-- ===================================================================
-- 2. IDENTITE ET DROITS  (CDCS 6.1, 12.2, 12.3)
-- ===================================================================

CREATE TABLE "user" (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text UNIQUE,
  phone             text UNIQUE,                      -- E.164, ex. +2250700000000
  password_hash     text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  roles             text[] NOT NULL DEFAULT '{}',
  locale            text NOT NULL DEFAULT 'fr',
  preferred_channel text NOT NULL DEFAULT 'sms'
                      CHECK (preferred_channel IN ('email', 'sms', 'push', 'whatsapp')),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  last_login_at     timestamptz,
  -- tracabilite de la derniere connexion (CDCS 12.5)
  last_login_ip     inet,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  -- au moins un identifiant est obligatoire
  CONSTRAINT user_identifier_required CHECK (email IS NOT NULL OR phone IS NOT NULL),
  -- un compte verifie est un compte actif (CDCS 7.1)
  CONSTRAINT user_active_is_verified CHECK (
    status <> 'active' OR phone_verified_at IS NOT NULL OR email_verified_at IS NOT NULL
  )
);

CREATE INDEX user_status_idx  ON "user" (status);
CREATE INDEX user_roles_idx   ON "user" USING gin (roles);
CREATE INDEX user_created_idx ON "user" (created_at DESC);

-- refresh tokens : detection de reutilisation (CDCS 12.2)
CREATE TABLE auth_refresh_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,                 -- jamais le token en clair
  device_label  text,
  ip            inet,
  user_agent    text,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  -- consomme par la rotation : detecte une reutilisation
  replaced_by_id uuid REFERENCES auth_refresh_token (id) ON DELETE SET NULL
);

CREATE INDEX auth_refresh_user_idx    ON auth_refresh_token (user_id);
CREATE INDEX auth_refresh_expires_idx ON auth_refresh_token (expires_at);

-- codes de verification (OTP), CDCS 7.1 / 12.2
CREATE TABLE auth_otp (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('phone_verification', 'login', 'password_reset', '2fa')),
  code_hash  text NOT NULL,                           -- Argon2, jamais en clair
  attempts   smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_otp_user_idx ON auth_otp (user_id, purpose);

-- ===================================================================
-- 3. FOURNISSEURS : agence, proprietaire, chauffeur  (CDCS 8)
-- ===================================================================

-- formules d'abonnement (CDCS 4.4)
CREATE TABLE plan (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL UNIQUE CHECK (key IN ('starter', 'business', 'premium', 'enterprise')),
  label             text NOT NULL,
  vehicle_limit     integer NOT NULL,                 -- -1 = illimite
  member_limit      integer NOT NULL DEFAULT 1,
  commission_rate   numeric(5, 4) NOT NULL DEFAULT 0, -- ex. 0.1200 = 12 %
  price_amount      bigint NOT NULL DEFAULT 0,
  currency_code     char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  features          jsonb NOT NULL DEFAULT '{}',
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        smallint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agency (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  slug                 text NOT NULL UNIQUE,
  legal_name           text,
  -- identifiants registraux (CDCS 3.3)
  rccm                 text,                          -- registre du commerce
  ifu                  text,                          -- identifiant fiscal unique
  plan_id              uuid REFERENCES plan (id) ON DELETE SET NULL,
  commission_rate      numeric(5, 4),                 -- surcharge facultative du plan
  city_id              uuid REFERENCES location (id) ON DELETE SET NULL,
  address              text,
  phone                text,
  email                text,
  logo_url             text,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  rating               numeric(3, 2),
  ratings_count        integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  version              integer NOT NULL DEFAULT 1
);

CREATE INDEX agency_status_idx ON agency (status);
CREATE INDEX agency_city_idx   ON agency (city_id);

CREATE TABLE subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    uuid NOT NULL REFERENCES agency (id) ON DELETE CASCADE,
  plan_id      uuid NOT NULL REFERENCES plan (id) ON DELETE RESTRICT,
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  renews_at    timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscription_agency_idx ON subscription (agency_id, status);

-- collaborateurs d'agence, avec permissions par ressource (CDCS 5.3, 12.3)
CREATE TABLE agency_member (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES agency (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'agent', 'accountant')),
  permissions text[] NOT NULL DEFAULT '{}',
  joined_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, user_id)
);

CREATE INDEX agency_member_user_idx ON agency_member (user_id);

CREATE TABLE driver (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  agency_id          uuid REFERENCES agency (id) ON DELETE SET NULL,
  -- proprietaire independant : chauffeur sans agence
  license_number     text,
  license_expiry     date,
  rating             numeric(3, 2),
  ratings_count      integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1
);

CREATE INDEX driver_agency_idx ON driver (agency_id, status);
CREATE INDEX driver_user_idx   ON driver (user_id);

-- ===================================================================
-- 4. CATALOGUE VEHICULES  (CDCS 6.2, 10)
-- ===================================================================

CREATE TABLE vehicle_category (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  label            text NOT NULL,
  -- schema d'attributs propre a la categorie (CDCS 9.1)
  attributes_schema jsonb NOT NULL DEFAULT '{}',
  icon_url         text,
  sort_order       smallint NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- provider_type : Exclusive, un vehicule appartient SOIT a une agence,
  -- SOIT a un proprietaire independant (CDCS 9.3)
  provider_type    text NOT NULL CHECK (provider_type IN ('agency', 'owner')),
  agency_id        uuid REFERENCES agency (id) ON DELETE CASCADE,
  owner_id         uuid REFERENCES "user" (id) ON DELETE CASCADE,
  category_id      uuid NOT NULL REFERENCES vehicle_category (id) ON DELETE RESTRICT,
  brand            text NOT NULL,
  model            text NOT NULL,
  year             smallint NOT NULL CHECK (year BETWEEN 1950 AND 2100),
  -- immatriculation : la plaque seule est trop peu discriminante
  plate_country    char(2) NOT NULL DEFAULT 'CI',
  plate_number     text NOT NULL,
  color            text,
  transmission     text NOT NULL CHECK (transmission IN ('manual', 'automatic')),
  fuel             text NOT NULL CHECK (fuel IN ('petrol', 'diesel', 'hybrid', 'electric', 'lpg')),
  seats            smallint NOT NULL CHECK (seats BETWEEN 1 AND 30),
  air_conditioning boolean NOT NULL DEFAULT true,
  doors            smallint,
  luggage_capacity smallint,
  consumption      numeric(5, 2),                    -- l/100km ou kWh/100km
  -- CDCS 4.3 : montants en centimes, jamais de flottant
  daily_rate       bigint NOT NULL CHECK (daily_rate >= 0),
  deposit_amount   bigint NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  currency_code    char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  with_driver      boolean NOT NULL DEFAULT false,
  driver_included_in_rate boolean NOT NULL DEFAULT false,
  min_days         smallint NOT NULL DEFAULT 1,
  max_km_per_day   integer,
  location_id      uuid REFERENCES location (id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'in_review', 'published', 'rejected', 'archived')),
  published_at     timestamptz,
  rating           numeric(3, 2),
  ratings_count    integer NOT NULL DEFAULT 0,
  -- CDCS 7.2 : un vehicule publie doit etre complet
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT vehicle_agency_owner_exclusive CHECK (
    (provider_type = 'agency' AND agency_id IS NOT NULL AND owner_id IS NULL) OR
    (provider_type = 'owner'  AND owner_id  IS NOT NULL AND agency_id IS NULL)
  ),
  CONSTRAINT vehicle_unique_plate UNIQUE (plate_country, plate_number)
);

-- index de recherche (CDCS 9.2)
CREATE INDEX vehicle_status_idx   ON vehicle (status) WHERE deleted_at IS NULL;
CREATE INDEX vehicle_category_idx ON vehicle (category_id);
CREATE INDEX vehicle_location_idx ON vehicle (location_id);
CREATE INDEX vehicle_agency_idx   ON vehicle (agency_id) WHERE agency_id IS NOT NULL;
CREATE INDEX vehicle_owner_idx    ON vehicle (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX vehicle_rate_idx     ON vehicle (daily_rate);
CREATE INDEX vehicle_year_idx     ON vehicle (year DESC);
CREATE INDEX vehicle_with_driver_idx ON vehicle (with_driver);

-- recherche plein texte insensible aux accents (CDCS 11.9).
-- Volontairement une colonne maintenue par trigger et NON une colonne
-- generee : PostgreSQL interdit les sous-requetes dans une expression
-- de generation, or la categorie doit intervenir dans l'index.
ALTER TABLE vehicle ADD COLUMN search_vector tsvector NOT NULL DEFAULT ''::tsvector;

CREATE OR REPLACE FUNCTION vehicle_search_vector() RETURNS trigger AS $$
DECLARE
  category_label text;
BEGIN
  SELECT c.label INTO category_label
  FROM vehicle_category c
  WHERE c.id = NEW.category_id;

  NEW.search_vector := setweight(
    to_tsvector('simple', unaccent(coalesce(NEW.brand, ''))), 'A') ||
  setweight(
    to_tsvector('simple', unaccent(coalesce(NEW.model, ''))), 'A') ||
  setweight(
    to_tsvector('simple', unaccent(coalesce(category_label, ''))), 'B');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_vehicle_search_vector
  BEFORE INSERT OR UPDATE OF brand, model, category_id
  ON vehicle
  FOR EACH ROW EXECUTE FUNCTION vehicle_search_vector();

CREATE INDEX vehicle_search_idx ON vehicle USING gin (search_vector);

CREATE INDEX vehicle_brand_trgm ON vehicle USING gin (brand gin_trgm_ops);
CREATE INDEX vehicle_model_trgm ON vehicle USING gin (model gin_trgm_ops);

CREATE TABLE vehicle_feature (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicle (id) ON DELETE CASCADE,
  code       text NOT NULL,
  label      text NOT NULL,
  UNIQUE (vehicle_id, code)
);

CREATE TABLE vehicle_media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicle (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('photo', 'video')),
  url        text NOT NULL,
  -- dimensions stockees : evite tout recalcul de mise en page (CDCS 9.2)
  width      integer,
  height     integer,
  bytes      bigint,
  sort_order smallint NOT NULL DEFAULT 0,
  is_cover   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vehicle_media_vehicle_idx ON vehicle_media (vehicle_id, sort_order);

-- documents de conformite, avec alerte d'expiration (CDCS 3.1)
CREATE TABLE vehicle_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  uuid NOT NULL REFERENCES vehicle (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN (
                'registration',   -- carte grise
                'insurance',      -- assurance flotte
                'rca',            -- responsabilite civile auto
                'technical_control', -- controle technique
                'agency_licence'  -- agrement / carte professionnelle
              )),
  file_url    text NOT NULL,
  issued_at   date,
  expires_at  date,
  -- statut derive : un document expire bloque la publication (CDCS 7.2)
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'valid', 'expired', 'rejected')),
  reviewed_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  reject_reason text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, kind)
);

CREATE INDEX vehicle_document_expiry_idx ON vehicle_document (expires_at)
  WHERE status = 'valid';

-- ===================================================================
-- 5. DISPONIBILITE  (CDCS 8.6)
-- ===================================================================

CREATE TABLE availability (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicle (id) ON DELETE CASCADE,
  start_at   timestamptz NOT NULL,
  end_at     timestamptz NOT NULL,
  type       text NOT NULL CHECK (type IN ('available', 'blocked', 'maintenance')),
  reason     text,
  created_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- CDCS 8.2 : bornes exclusives, pas d'intervalle vide
  CONSTRAINT availability_range_valid CHECK (end_at > start_at)
);

CREATE INDEX availability_vehicle_idx ON availability (vehicle_id, start_at, end_at);
CREATE INDEX availability_range_idx   ON availability (vehicle_id) WHERE type IN ('blocked', 'maintenance');

-- ===================================================================
-- 6. RESERVATION  (CDCS 8.1, 8.2)
-- ===================================================================

CREATE TABLE booking (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- reference courte communiquee au client et utilisee en reference de paiement
  reference      text NOT NULL UNIQUE,
  client_id      uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  provider_type  text NOT NULL CHECK (provider_type IN ('agency', 'owner')),
  agency_id      uuid REFERENCES agency (id) ON DELETE RESTRICT,
  owner_id       uuid REFERENCES "user" (id) ON DELETE RESTRICT,
  vehicle_id     uuid NOT NULL REFERENCES vehicle (id) ON DELETE RESTRICT,
  start_at       timestamptz NOT NULL,
  end_at         timestamptz NOT NULL,
  pickup_location_id   uuid REFERENCES location (id) ON DELETE SET NULL,
  return_location_id   uuid REFERENCES location (id) ON DELETE SET NULL,
  -- aller simple (CDCS 6.3 F-29)
  is_one_way     boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN (
                     'draft', 'awaiting_payment', 'paid', 'in_progress',
                     'late_return', 'completed', 'disputed',
                     'cancelled_client', 'cancelled_provider', 'expired',
                     'resolved_client', 'resolved_provider', 'resolved_split', 'closed'
                   )),
  -- instantane du devis : le prix ne peut jamais etre recalcule apres coup (CDCS 7.5)
  pricing_snapshot jsonb NOT NULL,
  currency_code  char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  total_amount   bigint NOT NULL CHECK (total_amount >= 0),
  deposit_amount bigint NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  commission_rate numeric(5, 4),                       -- fige a la reservation (CDCS 8.5)
  customer_notes text,
  -- CDCS 11.2 / 12.5 : signatures et main courante
  confirmed_at   timestamptz,
  started_at     timestamptz,
  ended_at       timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT booking_range_valid CHECK (end_at > start_at),
  CONSTRAINT booking_provider_exclusive CHECK (
    (provider_type = 'agency' AND agency_id IS NOT NULL AND owner_id IS NULL) OR
    (provider_type = 'owner'  AND owner_id  IS NOT NULL AND agency_id IS NULL)
  )
);

CREATE INDEX booking_client_idx   ON booking (client_id, start_at DESC);
CREATE INDEX booking_vehicle_idx  ON booking (vehicle_id, start_at DESC);
CREATE INDEX booking_agency_idx   ON booking (agency_id, start_at DESC) WHERE agency_id IS NOT NULL;
CREATE INDEX booking_owner_idx    ON booking (owner_id, start_at DESC) WHERE owner_id IS NOT NULL;
CREATE INDEX booking_status_idx   ON booking (status);
CREATE INDEX booking_created_idx  ON booking (created_at DESC);

-- CDCS 8.2 : la machine a etats se reduit a cet index.
-- Toute reservation non terminale occupe une plage [start_at, end_at)
-- sur son vehicule. Les bornes sont exclusives, donc deux locations
-- qui se touchent ne sont PAS en conflit.
CREATE INDEX booking_occupancy_idx ON booking (vehicle_id, start_at, end_at)
  WHERE status IN (
    'awaiting_payment', 'paid', 'in_progress', 'late_return', 'disputed'
  );

CREATE TABLE booking_status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES booking (id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid REFERENCES "user" (id) ON DELETE SET NULL,
  reason      text,
  ip          inet,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX booking_history_idx ON booking_status_history (booking_id, at DESC);

-- ===================================================================
-- 7. PAIEMENT ET TRESORERIE  (CDCS 4.2, 14)
-- ===================================================================

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES booking (id) ON DELETE RESTRICT,
  -- CDCS 14.2 : une implementation par operateur, jamais de fusion
  provider_key  text NOT NULL,                       -- ex. 'orange_money', 'wave'
  method        text NOT NULL CHECK (method IN ('mobile_money', 'card', 'cash', 'transfer')),
  kind          text NOT NULL DEFAULT 'rental'
                  CHECK (kind IN ('rental', 'deposit', 'penalty', 'extra_charge', 'subscription')),
  -- CDCS 4.3 : bigint en centimes
  amount        bigint NOT NULL CHECK (amount >= 0),
  currency_code char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded')),
  -- reference cote prestataire de paiement, pour la reconciliation (CDCS 14.2)
  external_ref  text,
  -- charge utile du webhook conservee pour l'audit
  raw_payload   jsonb,
  idempotency_key text UNIQUE,                       -- CDCS 12.6
  failure_code  text,
  failure_reason text,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_booking_idx  ON payment (booking_id);
CREATE INDEX payment_external_idx ON payment (provider_key, external_ref);
CREATE INDEX payment_status_idx   ON payment (status);
CREATE INDEX payment_reconcile_idx ON payment (provider_key, status) WHERE status = 'pending';

CREATE TABLE refund (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payment (id) ON DELETE RESTRICT,
  kind       text NOT NULL CHECK (kind IN ('refund', 'deposit_release', 'deposit_capture', 'chargeback')),
  amount     bigint NOT NULL CHECK (amount > 0),
  currency_code char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  status     text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'succeeded', 'failed')),
  reason     text NOT NULL,
  requested_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX refund_payment_idx ON refund (payment_id);

CREATE TABLE payout (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type    text NOT NULL CHECK (provider_type IN ('agency', 'owner')),
  agency_id        uuid REFERENCES agency (id) ON DELETE CASCADE,
  owner_id         uuid REFERENCES "user" (id) ON DELETE CASCADE,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  gross_amount     bigint NOT NULL DEFAULT 0,
  commission_amount bigint NOT NULL DEFAULT 0,
  tax_amount       bigint NOT NULL DEFAULT 0,
  net_amount       bigint NOT NULL DEFAULT 0,
  currency_code    char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'approved', 'processing', 'paid', 'failed')),
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_provider_exclusive CHECK (
    (provider_type = 'agency' AND agency_id IS NOT NULL AND owner_id IS NULL) OR
    (provider_type = 'owner'  AND owner_id  IS NOT NULL AND agency_id IS NULL)
  ),
  UNIQUE (provider_type, agency_id, owner_id, period_start, period_end)
);

CREATE INDEX payout_provider_idx ON payout (agency_id, owner_id, status);

-- ===================================================================
-- 8. CONTRAT, PRISE EN CHARGE, RESTITUTION  (CDCS 6.5)
-- ===================================================================

CREATE TABLE contract (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES booking (id) ON DELETE RESTRICT,
  version     smallint NOT NULL DEFAULT 1,
  pdf_url     text,
  checksum    text,
  status      text NOT NULL DEFAULT 'generated'
                CHECK (status IN ('generated', 'sent', 'partially_signed', 'signed', 'void', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, version)
);

CREATE TABLE signature (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contract (id) ON DELETE RESTRICT,
  signer_id   uuid REFERENCES "user" (id) ON DELETE SET NULL,
  signer_role text NOT NULL CHECK (signer_role IN ('client', 'provider', 'witness')),
  signer_name text NOT NULL,
  method      text NOT NULL CHECK (method IN ('otp', 'drawn', 'typed')),
  -- empreinte du document signe : garantit l'integrite (CDCS 12.5)
  document_hash text NOT NULL,
  ip          inet,
  signed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, signer_id, signer_role)
);

CREATE TABLE handover (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES booking (id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN ('pickup', 'return')),
  performed_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  mileage      integer CHECK (mileage IS NULL OR mileage >= 0),
  fuel_level   smallint CHECK (fuel_level IS NULL OR fuel_level BETWEEN 0 AND 100),
  photos       text[] NOT NULL DEFAULT '{}',
  notes        text,
  signatures   text[] NOT NULL DEFAULT '{}',
  performed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, kind)
);

CREATE TABLE damage_report (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       uuid NOT NULL REFERENCES booking (id) ON DELETE RESTRICT,
  handover_id      uuid REFERENCES handover (id) ON DELETE SET NULL,
  reported_by      uuid REFERENCES "user" (id) ON DELETE SET NULL,
  description      text NOT NULL,
  photos           text[] NOT NULL DEFAULT '{}',
  estimated_amount bigint CHECK (estimated_amount IS NULL OR estimated_amount >= 0),
  currency_code    char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),
  status           text NOT NULL DEFAULT 'reported'
                     CHECK (status IN ('reported', 'acknowledged', 'contested', 'accepted', 'rejected', 'resolved')),
  resolution       text,
  resolved_by      uuid REFERENCES "user" (id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX damage_report_booking_idx ON damage_report (booking_id);

-- ===================================================================
-- 9. LITIGES  (CDCS 8.3)
-- ===================================================================

CREATE TABLE dispute (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES booking (id) ON DELETE RESTRICT,
  opened_by     uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  reason        text NOT NULL,
  description   text,
  evidence      text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'under_review', 'resolved', 'closed_without_action', 'closed_by_timeout')),
  outcome       text CHECK (outcome IN ('client', 'provider', 'split', 'none')),
  resolution    text,
  assigned_to   uuid REFERENCES "user" (id) ON DELETE SET NULL,
  resolved_by   uuid REFERENCES "user" (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- CDCS 8.3 : 48 h pour produire les pieces
  evidence_due_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  resolved_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dispute_booking_idx ON dispute (booking_id);
CREATE INDEX dispute_status_idx  ON dispute (status, created_at DESC);

-- ===================================================================
-- 10. CONFiance ET REPUTATION  (CDCS 6.6)
-- ===================================================================

CREATE TABLE review (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CDCS 9.3 : un avis par location, garantie par l'unicite
  booking_id  uuid NOT NULL UNIQUE REFERENCES booking (id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES vehicle (id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  status      text NOT NULL DEFAULT 'published'
                CHECK (status IN ('pending', 'published', 'hidden', 'deleted')),
  is_reported boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  -- CDCS 7.6 : un commentaire est obligatoire pour une note basse
  CONSTRAINT review_comment_required_on_low_rating CHECK (rating >= 4 OR comment IS NOT NULL)
);

CREATE INDEX review_vehicle_idx ON review (vehicle_id, created_at DESC) WHERE status = 'published';
CREATE INDEX review_author_idx  ON review (author_id);

CREATE TABLE review_report (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id  uuid NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  reason     text NOT NULL,
  status     text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'upheld', 'dismissed')),
  resolved_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (review_id, reporter_id)
);

CREATE TABLE review_response (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL UNIQUE REFERENCES review (id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ===================================================================
-- 11. COMMUNICATION  (CDCS 6.7)
-- ===================================================================

CREATE TABLE notification_preference (
  user_id   uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  event     text NOT NULL,
  channels  text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, event)
);

CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  event       text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'whatsapp')),
  -- CDCS 14.5 : la priorite SMS est une regle de repli, pas une preference
  priority    smallint NOT NULL DEFAULT 5,
  status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'bounced')),
  subject     text,
  body        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  provider_key text,
  external_ref text,
  error       text,
  attempts    smallint NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_user_idx  ON notification (user_id, created_at DESC);
CREATE INDEX notification_queue_idx ON notification (status, scheduled_at)
  WHERE status IN ('queued', 'sending');
CREATE INDEX notification_booking_idx ON notification ((payload->>'bookingId'));

CREATE TABLE conversation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES booking (id) ON DELETE SET NULL,
  subject    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_participant (
  conversation_id uuid NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  last_read_at    timestamptz,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation (id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  body            text,
  attachments     text[] NOT NULL DEFAULT '{}',
  -- CDCS 9.4 : la localisation brute est purgee (CDCS 8.7)
  location        jsonb,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT message_body_or_attachment CHECK (body IS NOT NULL OR cardinality(attachments) > 0)
);

CREATE INDEX message_conversation_idx ON message (conversation_id, sent_at DESC);

-- ===================================================================
-- 12. COMMERCIAL  (CDCS 4.1, 6.10)
-- ===================================================================

CREATE TABLE coupon (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('percent', 'amount')),
  value        bigint NOT NULL CHECK (value > 0),     -- 1000 = 10 %, ou 5000 = 50,00
  scope        text NOT NULL DEFAULT 'platform' CHECK (scope IN ('platform', 'category', 'agency', 'vehicle')),
  target_id    uuid,
  min_amount   bigint NOT NULL DEFAULT 0,
  max_uses     integer,
  used_count   integer NOT NULL DEFAULT 0,
  valid_from   timestamptz NOT NULL,
  valid_to     timestamptz,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coupon_validity_idx ON coupon (is_active, valid_from, valid_to);

CREATE TABLE cms_page (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL,
  locale     text NOT NULL DEFAULT 'fr',
  title      text NOT NULL,
  body       text NOT NULL,
  seo_title  text,
  seo_description text,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, locale)
);

CREATE TABLE faq_item (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category   text,
  question   text NOT NULL,
  answer     text NOT NULL,
  locale     text NOT NULL DEFAULT 'fr',
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE banner (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement  text NOT NULL,
  title      text,
  image_url  text NOT NULL,
  link_url   text,
  locale     text NOT NULL DEFAULT 'fr',
  starts_at  timestamptz,
  ends_at    timestamptz,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banner_window_valid CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  group_name text NOT NULL DEFAULT 'general',
  -- certaines valeurs sont sensibles : jamais en clair en base
  is_secret  boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES "user" (id) ON DELETE SET NULL,
  actor_role text,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  ip         inet,
  user_agent text,
  at         timestamptz NOT NULL DEFAULT now()
);

-- CDCS 12.5 : journal en ajout seul, conserve 3 ans
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_at_idx     ON audit_log (at DESC);

-- ===================================================================
-- 13. OUTILLAGE TECHNIQUE
-- ===================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
  trigger_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'country', '"user"', 'agency', 'subscription', 'plan', 'driver',
    'vehicle_category', 'vehicle', 'vehicle_document',
    'booking', 'payment', 'payout', 'contract', 'damage_report', 'dispute',
    'review', 'review_response', 'notification', 'conversation',
    'coupon', 'cms_page', 'faq_item', 'banner'
  ] LOOP
    -- le nom du trigger doit etre un identifiant valide : on retire
    -- les guillemets eventuels du nom de table (cas de "user")
    trigger_name := replace(t, '"', '');

    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %2$s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      trigger_name, t);
  END LOOP;
END
$$;

-- CDCS 8.2 : rejet applicatif du double chevauchement.
-- Le controle strict s'appuie sur une contrainte d'exclusion ; le
-- trigger fournit un message exploitable cote API.
CREATE OR REPLACE FUNCTION prevent_booking_overlap() RETURNS trigger AS $$
DECLARE
  conflict uuid;
BEGIN
  SELECT b.id INTO conflict
  FROM booking b
  WHERE b.vehicle_id = NEW.vehicle_id
    AND b.id <> NEW.id
    AND b.status IN ('awaiting_payment', 'paid', 'in_progress', 'late_return', 'disputed')
    AND b.start_at < NEW.end_at
    AND NEW.start_at < b.end_at
  LIMIT 1;

  IF conflict IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle_already_booked: % overlaps booking %', NEW.vehicle_id, conflict
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_booking_no_overlap
  BEFORE INSERT OR UPDATE OF vehicle_id, start_at, end_at, status
  ON booking
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_overlap();

-- CDCS 11.9 : recherche insensible aux accents et a la casse
CREATE OR REPLACE VIEW location_flat AS
SELECT
  l.id,
  l.country_code,
  l.name,
  l.type,
  parent.name AS parent_name,
  grandparent.name AS grandparent_name
FROM location l
LEFT JOIN location parent   ON parent.id = l.parent_id
LEFT JOIN location grandparent ON grandparent.id = parent.parent_id
WHERE l.deleted_at IS NULL;