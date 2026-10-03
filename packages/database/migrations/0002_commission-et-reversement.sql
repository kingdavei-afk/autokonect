-- ===================================================================
-- AdkCars CI - 0002 : commission par partenaire et reversement differe
--
-- DECISIONS STRUCTURANTES PRISES LE 03/10/2026 (CDCS 19) :
--
--   A-01  « J'encaisse et je reverse apres »
--         Modele B du CDCS 4.2 : la plateforme encaisse le paiement du
--         client, le detient, puis le reverse au fournisseur apres
--         deduction de sa commission.
--
--   A-05  « Les commissions peuvent varier selon le partenaire »
--         Le taux n'est pas unique : il se resout par ordre de
--         priorite, puis est FIGE sur la reservation.
--
-- Cette migration ajoute ce qui manquait au modele du 0001 :
--   * un taux de commission pour les proprietaires individuels
--     (seules les agences en avaient un) ;
--   * un delai de reversement configurable par partenaire ;
--   * les bornes de validite des taux ;
--   * une vue de tresorerie par partenaire.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Taux de commission pour les proprietaires individuels
-- -------------------------------------------------------------------
-- NULL signifie : appliquer le taux de la plateforme (setting
-- `platform.default_commission_rate`). Une valeur explicite prime.
ALTER TABLE "user"
  ADD COLUMN commission_rate numeric(5, 4),
  ADD COLUMN payout_delay_days smallint NOT NULL DEFAULT 3;

COMMENT ON COLUMN "user".commission_rate IS
  'Surcharge propre au partenaire. NULL = taux de la plateforme. '
  'Priorite : surcharge partenaire > formule > defaut plateforme.';

COMMENT ON COLUMN "user".payout_delay_days IS
  'Delai en jours entre l encaissement et le reverse au partenaire (A-01).';

-- -------------------------------------------------------------------
-- 1bis. Suppression de la double source de verite sur la formule
-- -------------------------------------------------------------------
-- Le schema 0001 portait `agency.plan_id` ET `subscription.plan_id`.
-- Deux colonnes pour la meme information : elles divergent des la
-- premiere modification de formule, et le taux applique devient
-- inexplicable (« quelle formule s applique a cette agence ? »).
--
-- `subscription` devient l'unique source : elle porte l'historique et
-- les dates de renouvellement, que `agency.plan_id` ne pouvait pas
-- contabiliser. La vue `provider_ledger` la lit deja.
ALTER TABLE agency DROP COLUMN IF EXISTS plan_id;

COMMENT ON TABLE subscription IS
  'Formule de l agence. Source UNIQUE du taux lie au plan : agency ne '
  'porte pas de plan_id, pour eviter deux verites divergentes.';

-- -------------------------------------------------------------------
-- 2. Delai de reversement pour les agences
-- -------------------------------------------------------------------
ALTER TABLE agency
  ADD COLUMN payout_delay_days smallint NOT NULL DEFAULT 3;

COMMENT ON COLUMN agency.payout_delay_days IS
  'Delai en jours entre l encaissement et le reverse au partenaire (A-01).';

-- -------------------------------------------------------------------
-- 3. Bornes de validite des taux
-- -------------------------------------------------------------------
-- Un taux negatif cree une dette envers le partenaire ; un taux
-- superieur a 100 % cree une dette envers le client. Les deux sont
-- des erreurs de saisie, pas des cas d'affaires.
ALTER TABLE "user"
  ADD CONSTRAINT user_commission_rate_range
    CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 1));

ALTER TABLE agency
  ADD CONSTRAINT agency_commission_rate_range
    CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 1));

ALTER TABLE plan
  ADD CONSTRAINT plan_commission_rate_range
    CHECK (commission_rate >= 0 AND commission_rate <= 1);

ALTER TABLE booking
  ADD CONSTRAINT booking_commission_rate_range
    CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 1));

-- Le delai ne peut pas etre negatif, et 0 signifie « reverse le jour
-- meme de l encaissement ».
ALTER TABLE "user"
  ADD CONSTRAINT user_payout_delay_valid
    CHECK (payout_delay_days >= 0 AND payout_delay_days <= 365);

ALTER TABLE agency
  ADD CONSTRAINT agency_payout_delay_valid
    CHECK (payout_delay_days >= 0 AND payout_delay_days <= 365);

-- -------------------------------------------------------------------
-- 4. Taux de commission fige sur la reservation
-- -------------------------------------------------------------------
-- Le taux applique doit etre fige a la CREATION de la reservation, pas
-- a son paiement : si la formule du partenaire change entre les deux,
-- la facture deja presentee au client ne doit pas bouger.
--
-- On rend explicite l'origine du taux fige, pour qu un litige soit
-- arbitrable sans avoir a reconstituer l historique des formules.
ALTER TABLE booking
  ADD COLUMN commission_source text;

COMMENT ON COLUMN booking.commission_source IS
  'Origine du taux fige : partner_override | plan | platform_default. '
  'Conserve pour rendre un litige arbitrable.';

ALTER TABLE booking
  ADD CONSTRAINT booking_commission_source_valid
  CHECK (
    commission_source IS NULL
    OR commission_source IN ('partner_override', 'plan', 'platform_default')
  );

-- -------------------------------------------------------------------
-- 5. Tresorerie par partenaire (A-01)
-- -------------------------------------------------------------------
-- Repond a LA question operationnelle du modele B :
--   « combien ai-je encaisse, combien dois-je reverser, et quand ? »
--
-- L encaissement part de la reservation REGLEE. La commission et la
-- TVA sont deduites au moment du calcul de la ligne de reversement.
CREATE VIEW provider_ledger AS
WITH provider AS (
  SELECT
    'agency'::text AS provider_type,
    a.id            AS provider_id,
    a.name          AS provider_name,
    a.commission_rate AS partner_rate,
    p.commission_rate AS plan_rate,
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
settled AS (
  SELECT
    b.provider_type,
    coalesce(b.agency_id, b.owner_id) AS provider_id,
    count(*)::int                                          AS booking_count,
    sum(b.total_amount - b.deposit_amount)::numeric        AS gross_amount,
    sum(b.deposit_amount)::numeric                         AS deposit_held,
    sum(b.total_amount)::numeric                           AS total_collected,
    max(b.ended_at)                                        AS last_activity
  FROM booking b
  WHERE b.status IN ('completed', 'closed', 'resolved_client', 'resolved_provider', 'resolved_split')
  GROUP BY 1, 2
),
reversed AS (
  SELECT
    provider_type,
    coalesce(agency_id, owner_id) AS provider_id,
    sum(net_amount)::numeric   AS net_paid,
    sum(commission_amount)::numeric AS commission_taken,
    sum(tax_amount)::numeric  AS tax_collected
  FROM payout
  WHERE status IN ('approved', 'processing', 'paid')
  GROUP BY 1, 2
)
SELECT
  pr.provider_type,
  pr.provider_id,
  pr.provider_name,
  pr.payout_delay_days,

  -- Resolution du taux : surcharge du partenaire, puis formule, puis
  -- defaut plateforme lu dans `setting`. La surcharge du partenaire
  -- prime meme si elle est plus faible que la formule : c est un accord
  -- commercial negocié, pas une erreur.
  COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate) AS effective_rate,
  CASE
    WHEN pr.partner_rate IS NOT NULL THEN 'partner_override'
    WHEN pr.plan_rate  IS NOT NULL THEN 'plan'
    ELSE 'platform_default'
  END AS rate_source,

  coalesce(s.booking_count, 0)      AS booking_count,
  coalesce(s.gross_amount, 0)       AS gross_amount,
  coalesce(s.deposit_held, 0)       AS deposit_held,
  coalesce(s.total_collected, 0)    AS total_collected,
  coalesce(r.net_paid, 0)           AS net_paid,
  coalesce(r.commission_taken, 0)    AS commission_taken,
  coalesce(r.tax_collected, 0)      AS tax_collected,

  -- Solde restant du au partenaire.
  --
  -- Ce que la plateforme detient encore et devra lui verser. On deduit
  -- le NET deja verse, mais aussi la commission et la TVA deja
  -- prelevees lors des reversements anterieurs : ce sont des sommes
  -- RETENUES, pas des sommes DUES. Sans cette deduction, le solde
  -- affichait 1 062 000 apres un virement de 8 938 000, alors que la
  -- plateforme avait deja entierement solde le dossier.
  coalesce(s.gross_amount, 0)
    - coalesce(r.net_paid, 0)
    - coalesce(r.commission_taken, 0)
    - coalesce(r.tax_collected, 0) AS balance_due,

  -- Commission et TVA calculees sur le SOLDE restant du.
  --
  -- La commission porte sur `(encaissé - déjà reversé)`. La forme
  -- `encaissé - reversé - encaissé x taux` retournait 9 100 000 sur
  -- 10 000 000 à 9 %, au lieu de 900 000.
  round((coalesce(s.gross_amount, 0)
         - coalesce(r.net_paid, 0)
         - coalesce(r.commission_taken, 0)
         - coalesce(r.tax_collected, 0))
        * COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate)
      )::numeric AS commission_on_balance,
  round((coalesce(s.gross_amount, 0)
         - coalesce(r.net_paid, 0)
         - coalesce(r.commission_taken, 0)
         - coalesce(r.tax_collected, 0))
        * COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate)
        * vat_rate.rate
      )::numeric AS vat_on_balance,
  -- Montant du prochain virement : solde du moins commission et TVA.
  round((coalesce(s.gross_amount, 0)
         - coalesce(r.net_paid, 0)
         - coalesce(r.commission_taken, 0)
         - coalesce(r.tax_collected, 0))
        * (1 - COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate)
             * (1 + vat_rate.rate))
      )::numeric AS net_to_pay,

  s.last_activity
FROM provider pr
LEFT JOIN settled  s ON s.provider_type = pr.provider_type AND s.provider_id = pr.provider_id
LEFT JOIN reversed r ON r.provider_type = pr.provider_type AND r.provider_id = pr.provider_id
LEFT JOIN LATERAL (
  SELECT (value #>> '{}')::numeric AS rate
  FROM setting
  WHERE key = 'platform.default_commission_rate'
    AND NOT is_secret
) platform_default ON true
LEFT JOIN LATERAL (
  SELECT COALESCE((value #>> '{}')::numeric, 0.12) AS rate
  FROM setting
  WHERE key = 'platform.vat_rate'
    AND NOT is_secret
) vat_rate ON true;

COMMENT ON VIEW provider_ledger IS
  'Tresorerie par partenaire : encaisse, commission, TVA, net reverse, '
  'solde du. Repond a la question operationnelle du modele A-01.';

-- -------------------------------------------------------------------
-- 6. Valeurs de reference de la plateforme
-- -------------------------------------------------------------------
-- Inserees sans ecraser une valeur deja fixee par l administrateur :
-- `ON CONFLICT DO NOTHING` laisse la main a la configuration.
INSERT INTO setting (key, value, group_name, is_secret) VALUES
  ('platform.default_commission_rate', '0.12'::jsonb, 'monetisation', false),
  ('platform.vat_rate',                '0.18'::jsonb, 'monetisation', false),
  ('platform.currency',                '"XOF"'::jsonb, 'monetisation', false)
ON CONFLICT (key) DO NOTHING;

-- Valeurs DOCIBLES et non operationnelles :
--   * 12 % de commission est une HYPOTHESE de travail, pas une decision
--     commerciale ;
--   * 18 % de TVA est le taux usuel en Cote d'Ivoire, a confirmer par
--     un fiscaliste (CDCS 3.3) ;
--   * les deux sont modifiables a chaud par l administrateur.
COMMENT ON TABLE setting IS
  'Configuration de la plateforme. Les valeurs de monetisation posees par '
  'la migration sont des hypotheses de travail (A-05), pas des decisions '
  'commerciales definitives.';