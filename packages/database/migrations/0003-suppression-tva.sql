-- ===================================================================
-- AdkCars CI - 0003 : suppression de la TVA
--
-- DECISION STRUCTURANTE (03/10/2026, A-07) : « pas de TVA ».
--
-- La plateforme ne collecte ni n'ajoute de TVA. Toute la logique de
-- TVA introduite par la migration 0002 est retiree.
--
-- ------------------------------------------------------------------------
-- AVERTISSEMENT — CE QUI RESTE A VALIDER
-- ------------------------------------------------------------------------
-- « Pas de TVA » n'est pas un choix commercial libre : c'est une
-- CONSEQUENCE JURIDIQUE de la forme de la plateforme.
--
-- En Cote d'Ivoire, une entreprise assujettie a la TVA doit la
-- collecter sur ses services et la reverser au Tresor, meme si elle
-- ne l'affiche pas a ses clients. Deux cas :
--
--   1. La plateforme N'EST PAS assujettie (seuils de chiffre
--      d'affaires non atteints, activite non taxable). Alors
--      « pas de TVA » est parfaitement coherent, et c'est ce que
--      cette migration met en place.
--
--   2. La plateforme EST assujettie. Alors ne pas collecter la TVA
--      n'est pas une simplification : c'est une manquement, expose a
--      la sanction et au redressement. Le fait que la plateforme
--      encaisse au nom des partenaires ne change rien : l'assujetti
--      depend du service reellement fourni, pas du flux de paiement.
--
-- Cette migration NE VALIDE PAS le cas 1. Elle rend le modele coherent
-- avec la decision. La confirmation doit venir d'un fiscaliste ou d'un
-- comptable (CDCS 3.3), AVANT toute collecte de fonds reels.
--
-- Concretement, tant que ce point n'est pas confirme :
--   * encaisser de l'argent reel sans etre en ordre sur ce point
--     expose la plateforme ;
--   * le module Paiement ne doit pas etre active en production.
-- ------------------------------------------------------------------------
--
-- REVERSIBILITE : la colonne `payout.tax_amount` est CONSERVEE et
-- contrainte a zero. Si la plateforme devient assujettie, il suffira
-- de remettre le taux et de lever la contrainte ; aucune reconstruction
-- de donnees n'est necessaire.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Retrait du taux de TVA de la configuration
-- -------------------------------------------------------------------
DELETE FROM setting WHERE key = 'platform.vat_rate';

-- Drapeau explicite plutot qu'une absence silencieuse : l'etat fiscal
-- de la plateforme doit etre CONSULTABLE, pas deduit d'une colonne
-- manquante.
INSERT INTO setting (key, value, group_name, is_secret) VALUES
  ('platform.vat_registered', 'false'::jsonb, 'fiscalite', false)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE setting IS
  'Configuration de la plateforme. platform.vat_registered=false signifie '
  'que la plateforme NA COLLECTE PAS de TVA. Cette valeur doit etre '
  'confirmee par un fiscaliste (CDCS 3.3) avant toute collecte de fonds '
  'reels : une plateforme assujettie a la TVA reste redevable meme si '
  'elle ne l affiche pas a ses clients.';

-- -------------------------------------------------------------------
-- 2. Neutralisation de la colonne de TVA sur les reversements
-- -------------------------------------------------------------------
-- La colonne est conservee pour ne pas perdre l'information historique
-- et pour permettre un retour arriere si la plateforme devient
-- assujettie. Elle est desormais contrainte a zero.
ALTER TABLE payout
  ADD CONSTRAINT payout_no_tax
    CHECK (tax_amount = 0);

COMMENT ON COLUMN payout.tax_amount IS
  'Toujours 0 : la plateforme ne collecte pas de TVA (migration 0003). '
  'Colonne conservee pour la reversibilite si la plateforme devient '
  'assujettie.';

-- -------------------------------------------------------------------
-- 3. Reconstruction de la vue de tresorerie sans TVA
-- -------------------------------------------------------------------
-- Une vue se reconstruit par DROP puis CREATE : CREATE OR REPLACE VIEW
-- ne permet pas de retirer une colonne.
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
settled AS (
  SELECT
    b.provider_type,
    coalesce(b.agency_id, b.owner_id) AS provider_id,
    count(*)::int                                   AS booking_count,
    sum(b.total_amount - b.deposit_amount)::numeric AS gross_amount,
    sum(b.deposit_amount)::numeric                  AS deposit_held,
    sum(b.total_amount)::numeric                    AS total_collected,
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
    coalesce(agency_id, owner_id)       AS provider_id,
    sum(net_amount)::numeric            AS net_paid,
    sum(commission_amount)::numeric     AS commission_taken
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
  -- defaut plateforme. La surcharge prime meme plus faible que la
  -- formule : c'est un accord commercial negocié.
  COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate) AS effective_rate,
  CASE
    WHEN pr.partner_rate IS NOT NULL THEN 'partner_override'
    WHEN pr.plan_rate  IS NOT NULL THEN 'plan'
    ELSE 'platform_default'
  END AS rate_source,

  coalesce(s.booking_count, 0)   AS booking_count,
  coalesce(s.gross_amount, 0)    AS gross_amount,
  coalesce(s.deposit_held, 0)    AS deposit_held,
  coalesce(s.total_collected, 0) AS total_collected,
  coalesce(r.net_paid, 0)        AS net_paid,
  coalesce(r.commission_taken, 0) AS commission_taken,

  -- Solde restant du au partenaire : ce que la plateforme detient
  -- encore et devra lui verser. La commission deja prelevee est
  -- RETENUE, pas DUE : elle est deduite ici, sinon le solde afficherait
  -- un montant deja solde par la plateforme.
  coalesce(s.gross_amount, 0)
    - coalesce(r.net_paid, 0)
    - coalesce(r.commission_taken, 0)                  AS balance_due,

  -- Commission du sur le solde restant du.
  round((coalesce(s.gross_amount, 0)
         - coalesce(r.net_paid, 0)
         - coalesce(r.commission_taken, 0))
        * COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate)
      )::numeric                                       AS commission_on_balance,

  -- Montant du prochain virement : solde du moins la commission.
  -- AUCUNE TVA n'est deduite : la plateforme n'en collecte pas (A-07).
  round((coalesce(s.gross_amount, 0)
         - coalesce(r.net_paid, 0)
         - coalesce(r.commission_taken, 0))
        * (1 - COALESCE(pr.partner_rate, pr.plan_rate, platform_default.rate))
      )::numeric                                       AS net_to_pay,

  s.last_activity
FROM provider pr
LEFT JOIN settled  s ON s.provider_type = pr.provider_type AND s.provider_id = pr.provider_id
LEFT JOIN reversed r ON r.provider_type = pr.provider_type AND r.provider_id = pr.provider_id
LEFT JOIN LATERAL (
  SELECT (value #>> '{}')::numeric AS rate
  FROM setting
  WHERE key = 'platform.default_commission_rate'
    AND NOT is_secret
) platform_default ON true;

COMMENT ON VIEW provider_ledger IS
  'Tresorerie par partenaire : encaisse, commission, net reverse, solde du. '
  'Aucun montant de TVA : la plateforme n en collecte pas (migration 0003).';