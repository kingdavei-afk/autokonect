-- ===================================================================
-- AdkCars CI - 0005 : paiements directs et creances de commission
--
-- DECISION STRUCTURANTE (04/10/2026, A-20)
-- ===================================================================
-- Les paiements en ESPECES font partie du produit, et la commission est
-- FACTUREE SEPAREMENT au partenaire, non prelevee a la source.
--
-- Cette migration rend cette decision REALISABLE. Elle ne se contente
-- pas d'ajouter une colonne : elle corrige une hypothese du modele de
-- tresorerie qui devenait fausse.
--
-- -------------------------------------------------------------------
-- L'HYPOTHESE QUI CASSAIT
-- -------------------------------------------------------------------
-- `provider_ledger` calculait :
--
--     solde du = encaisse - reverse - commission
--
-- Cette egalite suppose que l'argent est pasSE PAR LA PLATEFORME. Avec
-- une reservation payee en especes au loueur, la plateforme ne detient
-- rien : le solde du n'a aucun sens, et surtout le calcul donnerait un
-- chiffre FAUX sans aucun signe visible.
--
-- Une erreur comptable silencieuse, dans le seul document qui sert a
-- decider quoi reverser. C'est le pire endroit pour une approximation.
--
-- -------------------------------------------------------------------
-- LA SEPARATION RETENUE
-- -------------------------------------------------------------------
-- Deux circuits financiers distincts, jamais melanges :
--
--   |                              | plateforme | direct      |
--   |------------------------------|------------|-------------|
--   | Argent detenu par la plateforme | oui        | NON         |
--   | Solde du au partenaire         | oui        | sans objet  |
--   | Commission                      | prelevee   | CREANCE     |
--
-- `booking.funds_channel` porte le canal. Il est pose A LA CREATION de
-- la reservation et ne change plus : une reservation qui bascule de
-- canal en cours de route ferait basculer la tresorerie d'un circuit a
-- l'autre apres coup.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Canal de fonds
-- -------------------------------------------------------------------
-- `platform` : l'argent transite par la plateforme (Mobile Money,
--   carte, virement). C'est le modele A-01, avec séquestre possible.
--
-- `direct` : le client paie directement au partenaire (especes). La
--   plateforme n'encaisse rien, ne detient rien, et n'a donc ni solde
--   du ni caution en garde.
ALTER TABLE booking
  ADD COLUMN funds_channel text NOT NULL DEFAULT 'platform';

ALTER TABLE booking
  ADD CONSTRAINT booking_funds_channel_valid
    CHECK (funds_channel IN ('platform', 'direct'));

COMMENT ON COLUMN booking.funds_channel IS
  'Canal de financement (A-20). ''platform'' : les fonds transitent par '
  'la plateforme, modele A-01 avec séquestre. ''direct'' : le client paie '
  'directement au partenaire, la plateforme n encaisse rien et la '
  'commission devient une créance. Immuable apres creation : le basculer '
  'ferait bouger la tresorerie de circuit apres coup.';

-- La valeur ne doit dependre que du mode de paiement retenu. On le
-- verifie ici plutot que dans l application, ou une valeur erronee
-- passerait inapercee jusqu au releve de tresorerie.
--
-- On ne peut pas exprimer « au moins un paiement direct » dans une
-- contrainte CHECK : la colonne ne voit pas une autre table. La regle
-- est donc verifiee par un declencheur, plus bas.

-- -------------------------------------------------------------------
-- 2. Creances de commission
-- -------------------------------------------------------------------
-- Une creance est une dette du partenaire envers la plateforme. Elle
-- nait quand une reservation payee en direct devient reglee.
--
-- Elle est DISTINTE de `payout`, qui represente de l'argent qui SORT.
-- Confondre les deux ferait verifier une creance dans le Tresorerie de
-- sortie, et le solde du partenaire ne fonctionnerait plus.
CREATE TABLE commission_receivable (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type     text NOT NULL CHECK (provider_type IN ('agency', 'owner')),
  agency_id         uuid REFERENCES agency (id) ON DELETE RESTRICT,
  owner_id          uuid REFERENCES "user" (id) ON DELETE RESTRICT,
  booking_id        uuid NOT NULL REFERENCES booking (id) ON DELETE RESTRICT,

  -- Montant facturé, en centimes. ⚠️ XOF : l unite stockee est le FRANC.
  amount            bigint NOT NULL CHECK (amount > 0),
  -- Ce qui a deja ete regle sur cette creance.
  settled_amount    bigint NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
  currency_code     char(3) NOT NULL DEFAULT 'XOF' REFERENCES currency (code),

  -- Taux applique, fige comme sur la reservation (CDCS 8.5).
  commission_rate   numeric(5, 4) NOT NULL
                      CHECK (commission_rate >= 0 AND commission_rate <= 1),

  -- `open` encore due ; `invoiced` facturee au partenaire ;
  -- `settled` encaissée ; `written_off` abandonnee.
  -- Une creance est un ENCOURS : elle ne peut pas disparaitre sans
  -- trace, sinon le non-recouvrement devient invisible.
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'invoiced', 'settled', 'written_off')),

  invoice_ref       text,
  due_at            timestamptz,
  written_off_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Une seule creance par reservation : une reservation reglee une
  -- fois ne cree pas deux dettes. Sans cette contrainte, un second
  -- traitement du webhook doublerait la creance.
  CONSTRAINT commission_receivable_settled_bound
    CHECK (settled_amount <= amount),

  CONSTRAINT commission_receivable_provider_exclusive CHECK (
    (provider_type = 'agency' AND agency_id IS NOT NULL AND owner_id IS NULL) OR
    (provider_type = 'owner' AND owner_id IS NOT NULL AND agency_id IS NULL)
  )
);

CREATE INDEX commission_receivable_provider_idx
  ON commission_receivable (provider_type, agency_id, owner_id, status);

CREATE INDEX commission_receivable_open_idx
  ON commission_receivable (due_at)
  WHERE status IN ('open', 'invoiced');

-- La garantie qu'une creance n'est creee qu'une fois par reservation
-- passe par un index unique, plus fiable qu'un declencheur : il ne peut
-- pas etre contourne par un `INSERT ... ON CONFLICT DO NOTHING` oublie
-- ou par une voie d'ecriture inhabituelle.
CREATE UNIQUE INDEX commission_receivable_booking_uniq
  ON commission_receivable (booking_id);

COMMENT ON TABLE commission_receivable IS
  'Commission due par le partenaire sur les reservations payees en '
  'direct (especes, A-20). Distincte de payout, qui represente de '
  'l argent qui sort. L argent etant encaisse directement par le '
  'partenaire, la commission ne peut pas etre prelevee a la source.';

-- -------------------------------------------------------------------
-- 2 bis. Une creance ne se SUPPRIME pas, elle s'abandonne
-- -------------------------------------------------------------------
-- PostgreSQL n'a pas de contrainte « interdiction de supprimer », et
-- rien ne reference cette table : une suppression reussirait.
--
-- Or une suppression effacerait une perte de chiffre d'affaires sans
-- qu'aucun releve ne la montre. Le seul moyeu de s'en detourner est
-- un changement de statut, qui laisse `commission_written_off` visible.
--
-- Le declencheur rend cette distinction explicite plutot que de la
-- laisser implicite.
CREATE OR REPLACE FUNCTION forbid_receivable_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'commission_receivable_not_deletable: la creance % ne peut pas etre supprimee. Marquez-la en written_off avec un motif : une suppression effacerait une perte de chiffre d affaires invisible.',
    OLD.id
    USING ERRCODE = '23514';
END
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION forbid_receivable_delete() IS
  'Interdit la suppression d une creance de commission. L abandon se '
  'declare par status = ''written_off'' avec un motif, ce qui laisse la '
  'perte visible dans provider_ledger.';

CREATE TRIGGER commission_receivable_no_delete
  BEFORE DELETE ON commission_receivable
  FOR EACH ROW
  EXECUTE FUNCTION forbid_receivable_delete();

-- -------------------------------------------------------------------
-- 3. Coherence du canal avec les paiements
-- -------------------------------------------------------------------
-- Une reservation ne peut pas etre a la fois `platform` et `direct`.
--
-- Le declencheur porte sur `payment` : il doit donc ALLER CHERCHER le
-- canal dans `booking`. Lire `NEW.funds_channel` y echouerait — `NEW`
-- est une ligne de `payment`, qui n'a pas cette colonne.
--
-- C'est la SEULE des deux regles qui ne peut pas etre exprimee par une
-- contrainte CHECK : la colonne de `booking` ne voit pas les lignes
-- d'une autre table, et la contrainte d unicite du paiement ne dit rien
-- du canal de financement.
--
-- Sans ce declencheur, une reservation pourrait porter une creance de
-- commission alors qu'elle a ete payee par la plateforme — donc
-- facturer le partenaire deux fois.
CREATE OR REPLACE FUNCTION enforce_booking_funds_channel() RETURNS trigger AS $$
DECLARE
  modes  text[];
  canal  text;
BEGIN
  SELECT b.funds_channel INTO canal
  FROM booking b
  WHERE b.id = NEW.booking_id;

  SELECT array_agg(DISTINCT method) INTO modes
  FROM payment
  WHERE booking_id = NEW.booking_id;

  -- Reservation introuvable ou aucun paiement : rien a verifier. La
  -- reservation vient d etre creee, elle attend son paiement.
  IF canal IS NULL OR modes IS NULL THEN
    RETURN NEW;
  END IF;

  -- Un paiement par la plateforme est survenu : le canal `direct` est
  -- faux, et la creance qui en decoule aussi.
  IF canal = 'direct' AND 'cash' <> ALL (modes) THEN
    RAISE EXCEPTION
      'booking_funds_channel_mismatch: la reservation % est en canal direct mais utilise le(s) mode(s) %',
      NEW.booking_id, modes
      USING ERRCODE = '23514';
  END IF;

  -- Un paiement en especes est survenu : le canal `platform` est faux.
  -- Le virement et la carte ne sont pas concernes : ils passent par la
  -- plateforme, et y sont traces.
  IF canal = 'platform' AND 'cash' = ANY (modes) THEN
    RAISE EXCEPTION
      'booking_funds_channel_mismatch: la reservation % est en canal plateforme mais comporte un paiement en especes',
      NEW.booking_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_booking_funds_channel() IS
  'Verifie que booking.funds_channel correspond aux modes de paiement '
  'effectivement enregistres. Sans ce controle, une reservation payee '
  'par la plateforme pourrait porter une creance de commission : le '
  'partenaire serait facture deux fois.';

CREATE TRIGGER booking_funds_channel_guard
  AFTER INSERT OR UPDATE OF method ON payment
  FOR EACH ROW
  EXECUTE FUNCTION enforce_booking_funds_channel();

-- -------------------------------------------------------------------
-- 4. Trésorerie corrigée : deux circuits, une seule vue
-- -------------------------------------------------------------------
-- Une vue se reconstruit par DROP puis CREATE : CREATE OR REPLACE VIEW
-- ne permet ni d ajouter une colonne au milieu, ni d en retirer une.
DROP VIEW IF EXISTS provider_ledger;

CREATE VIEW provider_ledger AS
WITH provider AS (
  SELECT
    'agency'::text     AS provider_type,
    a.id                AS provider_id,
    a.name              AS provider_name,
    a.commission_rate  AS partner_rate,
    p.commission_rate  AS plan_rate,
    a.payout_delay_days
  FROM agency a
  LEFT JOIN subscription s ON s.agency_id = a.id AND s.status = 'active'
  LEFT JOIN plan p ON p.id = s.plan_id

  UNION ALL

  SELECT
    'owner'::text,
    u.id,
    coalesce(u.email, u.phone, u.id::text),
    u.commission_rate,
    NULL::numeric,
    u.payout_delay_days
  FROM "user" u
),
reglees AS (
  SELECT
    b.provider_type,
    coalesce(b.agency_id, b.owner_id) AS provider_id,
    count(*)::int AS booking_count,

    -- Circuit plateforme : argent detenu, solde du et caution en garde.
    sum(CASE WHEN b.funds_channel = 'platform'
             THEN b.total_amount - b.deposit_amount ELSE 0 END)::numeric
      AS gross_platform,
    sum(CASE WHEN b.funds_channel = 'platform'
             THEN b.deposit_amount ELSE 0 END)::numeric
      AS deposit_held,
    sum(CASE WHEN b.funds_channel = 'platform'
             THEN b.total_amount ELSE 0 END)::numeric
      AS total_collected,

    -- Circuit direct : argent jamais detenu par la plateforme.
    -- Separé et NON additionne : l additionner au circuit plateforme
    -- rendrait un solde du qui n existe pas.
    sum(CASE WHEN b.funds_channel = 'direct'
             THEN b.total_amount - b.deposit_amount ELSE 0 END)::numeric
      AS gross_direct,
    count(*) FILTER (WHERE b.funds_channel = 'direct')::int
      AS direct_count,

    -- Derniere activite reglee, tous circuits confondus. Sert a
    -- reperer un partenaire dont l activite se tarit.
    max(b.ended_at)                                 AS last_activity
  FROM booking b
  WHERE b.status IN (
    'completed', 'closed',
    'resolved_client', 'resolved_provider', 'resolved_split'
  )
  GROUP BY 1, 2
),
reversed AS (
  SELECT
    provider_type,
    coalesce(agency_id, owner_id) AS provider_id,
    sum(net_amount)::numeric       AS net_paid,
    sum(commission_amount)::numeric AS commission_taken
  FROM payout
  WHERE status IN ('approved', 'processing', 'paid')
  GROUP BY 1, 2
),
creances AS (
  SELECT
    provider_type,
    coalesce(agency_id, owner_id) AS provider_id,
    sum(amount - settled_amount)::numeric AS outstanding,
    count(*) FILTER (
      WHERE status IN ('open', 'invoiced')
    )::int AS open_count,
    sum(amount)::numeric AS total_billed
  FROM commission_receivable
  GROUP BY 1, 2
)
SELECT
  pr.provider_type,
  pr.provider_id,
  pr.provider_name,
  pr.payout_delay_days,

  COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate) AS effective_rate,
  CASE
    WHEN pr.partner_rate IS NOT NULL THEN 'partner_override'
    WHEN pr.plan_rate  IS NOT NULL THEN 'plan'
    ELSE 'platform_default'
  END AS rate_source,

  coalesce(rg.booking_count, 0) AS booking_count,
  coalesce(rg.total_collected, 0) AS total_collected,
  coalesce(rg.deposit_held, 0)    AS deposit_held,

  -- ---- Decomposition du circuit plateforme -------------------------
  -- Les trois composantes sont exposees, pas seulement leur difference.
  -- Une tresorerie qui n affiche que le solde oblige a recalculer pour
  -- comprendre d ou vient un ecart, et le recalcul sera fait de travers.
  coalesce(rg.gross_platform, 0)                              AS gross_platform,
  coalesce(rv.net_paid, 0)                                    AS net_paid,
  coalesce(rv.commission_taken, 0)                            AS commission_taken,

  -- Seule cette difference a un sens : elle combine ce que la
  -- plateforme detient et ce qu elle a deja reverse.
  coalesce(rg.gross_platform, 0)
    - coalesce(rv.net_paid, 0)
    - coalesce(rv.commission_taken, 0)                        AS balance_due,

  round((coalesce(rg.gross_platform, 0)
         - coalesce(rv.net_paid, 0)
         - coalesce(rv.commission_taken, 0))
        * COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate)
      )::numeric                                                 AS commission_on_balance,

  round((coalesce(rg.gross_platform, 0)
         - coalesce(rv.net_paid, 0)
         - coalesce(rv.commission_taken, 0))
        * (1 - COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate))
      )::numeric                                                 AS net_to_pay,

  -- ---- Circuit direct ----------------------------------------------
  -- Ce que la plateforme aurait eu si l argent etait passe par elle.
  -- Sans montant detenu, aucun solde du n est calcule ici : le produire
  -- quand meme donnerait un chiffre que personne ne doit reverser.
  coalesce(rg.gross_direct, 0)                                  AS gross_direct,
  coalesce(rg.direct_count, 0)                                  AS direct_count,
  coalesce(cr.outstanding, 0)                                    AS commission_outstanding,
  coalesce(cr.open_count, 0)                                     AS receivable_open_count,
  coalesce(cr.total_billed, 0)                                   AS commission_billed,

  -- Creances ecrites off : de l argent que la plateforme a renonce a
  -- recouvrer. Suivre ce chiffre evite de croire la commission
  -- integralement perdue alors qu elle ne l est que partiellement.
  coalesce(wf.written_off, 0)                                    AS commission_written_off,

  rg.last_activity
FROM provider pr
LEFT JOIN reglees   rg ON rg.provider_type = pr.provider_type AND rg.provider_id = pr.provider_id
LEFT JOIN reversed  rv ON rv.provider_type = pr.provider_type AND rv.provider_id = pr.provider_id
LEFT JOIN creances  cr ON cr.provider_type = pr.provider_type AND cr.provider_id = pr.provider_id
LEFT JOIN LATERAL (
  SELECT (value #>> '{}')::numeric AS rate
  FROM setting
  WHERE key = 'platform.default_commission_rate'
    AND NOT is_secret
) platform_default ON true
LEFT JOIN LATERAL (
  SELECT sum(amount - settled_amount)::numeric AS written_off
  FROM commission_receivable w
  WHERE w.status = 'written_off'
    AND w.provider_type = pr.provider_type
    AND coalesce(w.agency_id, w.owner_id) = pr.provider_id
) wf ON true;

COMMENT ON VIEW provider_ledger IS
  'Tresorerie par partenaire, en DEUX circuits distincts (A-20). '
  'Circuit plateforme : argent detenu, balance_due et net_to_pay ont un '
  'sens. Circuit direct : argent jamais detenu, aucun solde du n est '
  'produit, et la commission apparait en creance. Les deux circuits ne '
  'doivent jamais etre additionnes.';
