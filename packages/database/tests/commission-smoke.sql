-- ===================================================================
-- Tests de la migration 0002 : commission par partenaire et tresorerie
--
-- Verifie que les regles de reversement sont IMPOSEES PAR LA BASE.
--   psql -v ON_ERROR_STOP=1 -f schema-smoke.sql  (0001 deja applique)
-- ===================================================================

\set ON_ERROR_STOP on
BEGIN;

\echo ''
\echo '--- T11 : commission par partenaire prioritaire sur la formule ---'
DO $$
DECLARE
  r numeric;
  source text;
BEGIN
  -- Surcharge propre au partenaire individuel : c'est l apport de la
  -- migration 0002, le schema 0001 ne prevoyait de taux que pour les
  -- agences. Sans elle, la resolution retomberait sur le defaut
  -- plateforme et la priorite du taux partenaire ne serait jamais
  -- exercee pour un proprietaire.
  INSERT INTO "user" (email, phone, status, roles, phone_verified_at, commission_rate)
  VALUES ('partenaire@test.ci', '+2250700000099', 'active', '{owner}', now(), 0.0900);

  INSERT INTO plan (key, label, vehicle_limit, commission_rate)
  VALUES ('starter', 'Starter', 5, 0.1500)
  ON CONFLICT (key) DO UPDATE SET commission_rate = 0.1500;

  INSERT INTO agency (name, slug, commission_rate, status)
  VALUES ('Agence Test', 'agence-test', 0.0900, 'active');
  INSERT INTO subscription (agency_id, plan_id, status, started_at, renews_at)
  SELECT a.id, p.id, 'active', now(), now() + interval '1 year'
  FROM agency a, plan p WHERE a.slug = 'agence-test' AND p.key = 'starter';

  SELECT effective_rate, rate_source INTO r, source
  FROM provider_ledger WHERE provider_type = 'agency' AND provider_name = 'Agence Test';

  -- La surcharge du partenaire (9 %) prime sur la formule (15 %).
  IF r = 0.0900 AND source = 'partner_override' THEN
    RAISE NOTICE 'OK T11 : surcharge partenaire 9 %% prioritaire sur formule 15 %%';
  ELSE
    RAISE EXCEPTION 'ECHEC T11 : taux % (source %) au lieu de 0.09 / partner_override', r, source;
  END IF;
END
$$;

\echo ''
\echo '--- T12 : formule utilisee en l absence de surcharge ---'
DO $$
DECLARE
  r numeric;
  source text;
BEGIN
  UPDATE agency SET commission_rate = NULL WHERE slug = 'agence-test';

  SELECT effective_rate, rate_source INTO r, source
  FROM provider_ledger WHERE provider_type = 'agency' AND provider_name = 'Agence Test';

  IF r = 0.1500 AND source = 'plan' THEN
    RAISE NOTICE 'OK T12 : formule 15 %% appliquee (source=plan)';
  ELSE
    RAISE EXCEPTION 'ECHEC T12 : taux % (source %) au lieu de 0.15 / plan', r, source;
  END IF;
END
$$;

\echo ''
\echo '--- T13 : defaut plateforme si ni surcharge ni formule ---'
DO $$
DECLARE
  r numeric;
  source text;
BEGIN
  -- Depuis la migration 0002, `agency.plan_id` n'existe plus : la
  -- formule se lit via `subscription`. C'est elle qu'on desactive.
  UPDATE subscription SET status = 'expired'
  WHERE agency_id = (SELECT id FROM agency WHERE slug = 'agence-test');

  SELECT effective_rate, rate_source INTO r, source
  FROM provider_ledger WHERE provider_type = 'agency' AND provider_name = 'Agence Test';

  -- Aucune formule : on retombe sur le defaut plateforme (12 %).
  IF r = 0.1200 AND source = 'platform_default' THEN
    RAISE NOTICE 'OK T13 : defaut plateforme 12 %% appliquee';
  ELSE
    RAISE EXCEPTION 'ECHEC T13 : taux % (source %) au lieu de 0.12 / platform_default', r, source;
  END IF;
END
$$;

\echo ''
\echo '--- T14 : taux negatif ou superieur a 100 %% refuses ---'
DO $$
BEGIN
  BEGIN
    UPDATE agency SET commission_rate = -0.5 WHERE slug = 'agence-test';
    RAISE EXCEPTION 'ECHEC T14 : un taux negatif a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T14a : taux negatif refuse';
  END;

  BEGIN
    UPDATE agency SET commission_rate = 1.5 WHERE slug = 'agence-test';
    RAISE EXCEPTION 'ECHEC T14 : un taux superieur a 100 %% a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T14b : taux > 100 %% refuse';
  END;

  BEGIN
    UPDATE "user" SET commission_rate = 2 WHERE email = 'partenaire@test.ci';
    RAISE EXCEPTION 'ECHEC T14 : un taux > 100 %% sur un proprietaire a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T14c : taux > 100 %% refuse sur proprietaire';
  END;
END
$$;

\echo ''
\echo '--- T15 : delai de reversement valide ---'
DO $$
BEGIN
  BEGIN
    UPDATE agency SET payout_delay_days = -1 WHERE slug = 'agence-test';
    RAISE EXCEPTION 'ECHEC T15 : un delai negatif a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T15 : delai negatif refuse';
  END;
END
$$;

\echo ''
\echo '--- T16 : provenance du taux fige acceptee seulement si valide ---'
DO $$
DECLARE
  owner_id uuid;
  veh_id uuid;
  cat_id uuid;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'partenaire@test.ci';
  SELECT id INTO cat_id FROM vehicle_category LIMIT 1;

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model, year,
                       plate_number, transmission, fuel, seats, daily_rate, status)
  VALUES ('owner', owner_id, cat_id, 'Citroen', 'C3', 2021, 'CM-T16',
          'manual', 'petrol', 5, 3000000, 'published')
  RETURNING id INTO veh_id;

  -- `booking` ne porte pas `category_id` : la categorie vient du vehicule.
  BEGIN
    INSERT INTO booking (reference, client_id, provider_type, owner_id,
                         vehicle_id, start_at, end_at, status, pricing_snapshot,
                         total_amount, commission_rate, commission_source)
    VALUES ('COMM-1', owner_id, 'owner', owner_id, veh_id,
            '2026-12-01 08:00+00', '2026-12-03 18:00+00', 'paid', '{}',
            7000000, 0.09, 'inconnu');
    RAISE EXCEPTION 'ECHEC T16 : une provenance inconnue a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T16 : provenance de taux invalide refusee';
  END;

  -- En revanche, une provenance valide doit passer.
  INSERT INTO booking (reference, client_id, provider_type, owner_id,
                       vehicle_id, start_at, end_at, status, pricing_snapshot,
                       total_amount, commission_rate, commission_source)
  VALUES ('COMM-1B', owner_id, 'owner', owner_id, veh_id,
          '2026-12-20 08:00+00', '2026-12-22 18:00+00', 'paid', '{}',
          7000000, 0.09, 'partner_override');
  RAISE NOTICE 'OK T16bis : provenance valide acceptee';
END
$$;

\echo ''
\echo '--- T17 : tresorerie : solde du = encaisse - reverse ---'
DO $$
DECLARE
  ledger record;
BEGIN
  SELECT * INTO ledger FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = (
    SELECT id FROM "user" WHERE email = 'partenaire@test.ci'
  );

  -- Aucune reservation reglee : tout a zero.
  IF ledger.balance_due = 0 AND ledger.net_paid = 0 THEN
    RAISE NOTICE 'OK T17 : tresorerie a zero pour un partenaire inactif';
  ELSE
    RAISE EXCEPTION 'ECHEC T17 : balance_due %, net_paid %', ledger.balance_due, ledger.net_paid;
  END IF;
END
$$;

\echo ''
\echo '--- T18 : la caution est cloisonnee du chiffre d affaires ---'
DO $$
DECLARE
  owner_id uuid;
  veh_id uuid;
  cat_id uuid;
  gross numeric;
  deposit numeric;
  collected numeric;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'partenaire@test.ci';
  SELECT id INTO cat_id FROM vehicle_category LIMIT 1;

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model, year,
                       plate_number, transmission, fuel, seats, daily_rate, status)
  VALUES ('owner', owner_id, cat_id, 'Peugeot', '308', 2022, 'CM-0001',
          'manual', 'petrol', 5, 3500000, 'published')
  RETURNING id INTO veh_id;

  -- Reservation terminee : 3 jours a 3 500 000, caution 500 000.
  INSERT INTO booking (reference, client_id, provider_type, owner_id, vehicle_id,
                       start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, commission_rate, commission_source)
  VALUES ('COMM-2', owner_id, 'owner', owner_id, veh_id,
          '2026-12-10 08:00+00', '2026-12-13 18:00+00', 'completed', '{}',
          10500000, 500000, 0.09, 'partner_override');

  -- Les noms de la liste SELECT doivent etre les COLONNES de la vue.
  -- Ecrire `gross, deposit, collected` resoudrait sur les variables
  -- PL/pgSQL du meme nom : retour NULL, sans aucune erreur levee.
  SELECT gross_amount, deposit_held, total_collected
    INTO gross, deposit, collected
  FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = owner_id;

  -- La caution ne doit PAS compter dans le chiffre d affaires reversable.
  IF deposit = 500000 THEN
    RAISE NOTICE 'OK T18a : caution cloisonnee (500 000), hors chiffre d affaires';
  ELSE
    RAISE EXCEPTION 'ECHEC T18a : caution % (attendu 500000)', deposit;
  END IF;

  IF gross = 10500000 - 500000 THEN
    RAISE NOTICE 'OK T18b : chiffre d affaires = total - caution = 10 000 000';
  ELSE
    RAISE EXCEPTION 'ECHEC T18b : gross % au lieu de 10000000', gross;
  END IF;

  IF collected = 10500000 THEN
    RAISE NOTICE 'OK T18c : encaissement total 10 500 000 (caution incluse)';
  ELSE
    RAISE EXCEPTION 'ECHEC T18c : collected % au lieu de 10500000', collected;
  END IF;
END
$$;

\echo ''
\echo '--- T19 : commission et TVA calculees sur le solde du ---'
DO $$
DECLARE
  comm numeric;
  vat numeric;
  rate numeric;
BEGIN
  SELECT commission_on_balance, vat_on_balance, effective_rate
    INTO comm, vat, rate
  FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = (
    SELECT id FROM "user" WHERE email = 'partenaire@test.ci'
  );

  -- 10 000 000 encaisses, 9 % = 900 000 ; TVA 18 % sur 900 000 = 162 000.
  IF rate = 0.09 THEN
    RAISE NOTICE 'OK T19a : taux partenaire 9 %% retenu';
  ELSE
    RAISE EXCEPTION 'ECHEC T19a : taux % au lieu de 0.09', rate;
  END IF;

  IF comm = 900000 THEN
    RAISE NOTICE 'OK T19b : commission 900 000 sur le solde du';
  ELSE
    RAISE EXCEPTION 'ECHEC T19b : commission % au lieu de 900000', comm;
  END IF;

  IF vat = 162000 THEN
    RAISE NOTICE 'OK T19c : TVA 162 000 sur la commission';
  ELSE
    RAISE EXCEPTION 'ECHEC T19c : TVA % au lieu de 162000', vat;
  END IF;
END
$$;

\echo ''
\echo '--- T20 : apres reversement, le solde du diminue ---'
DO $$
DECLARE
  owner_id uuid;
  before_due numeric;
  after_due numeric;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'partenaire@test.ci';

  SELECT balance_due INTO before_due FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = owner_id;

  INSERT INTO payout (provider_type, owner_id, period_start, period_end,
                      gross_amount, commission_amount, tax_amount, net_amount,
                      status, paid_at)
  VALUES ('owner', owner_id, '2026-12-10', '2026-12-13',
          10000000, 900000, 162000, 8938000, 'paid', now());

  SELECT balance_due INTO after_due FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = owner_id;

  IF before_due = 10000000 AND after_due = 0 THEN
    RAISE NOTICE 'OK T20 : solde du solde apres reverse integral';
  ELSE
    RAISE EXCEPTION 'ECHEC T20 : avant %, apres % (attendu 0)', before_due, after_due;
  END IF;
END
$$;

\echo ''
\echo '--- T21 : reversement partiel laisse un solde ---'
DO $$
DECLARE
  -- Nom distinct de toute colonne : `partenaire` designait a la fois la
  -- variable locale et `vehicle.partenaire`, ce qui levait « column
  -- reference partenaire is ambiguous ».
  partenaire uuid;
  remaining numeric;
  net_next numeric;
BEGIN
  SELECT id INTO partenaire FROM "user" WHERE email = 'partenaire@test.ci';

  -- Dossier entierement solde par T20 : plus rien n est du.
  SELECT balance_due INTO remaining FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = partenaire;

  IF remaining = 0 THEN
    RAISE NOTICE 'OK T21a : solde restant nul apres reversement integral';
  ELSE
    RAISE EXCEPTION 'ECHEC T21a : solde restant % (attendu 0)', remaining;
  END IF;

  -- Nouvelle reservation terminee : un solde doit reapparaitre.
  INSERT INTO booking (reference, client_id, provider_type, owner_id, vehicle_id,
                       start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, commission_rate, commission_source)
  SELECT 'COMM-3', partenaire, 'owner', partenaire, v.id,
         '2027-01-10 08:00+00', '2027-01-12 18:00+00', 'completed', '{}',
         7000000, 0, 0.09, 'partner_override'
  FROM vehicle v WHERE v.plate_number = 'CM-0001';

  SELECT balance_due, net_to_pay INTO remaining, net_next
  FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = partenaire;

  IF remaining = 7000000 THEN
    RAISE NOTICE 'OK T21b : solde de 7 000 000 apres une nouvelle reservation';
  ELSE
    RAISE EXCEPTION 'ECHEC T21b : solde % (attendu 7000000)', remaining;
  END IF;

  -- 7 000 000 - 9 % - TVA 18 % sur la commission (113 400).
  --   commission = 630 000, TVA = 113 400, net = 6 256 600
  IF net_next = 6256600 THEN
    RAISE NOTICE 'OK T21c : prochain virement de 6 256 600';
  ELSE
    RAISE EXCEPTION 'ECHEC T21c : net a payer % (attendu 6256600)', net_next;
  END IF;

  RAISE NOTICE 'HYPOTHESE COMPTABLE : la TVA est ici DEDUITE du montant '
    'verse au partenaire. Ce traitement doit etre confirme par un '
    'fiscaliste (CDCS 3.3) : si la TVA est une charge propre de la '
    'plateforme, net_to_pay vaut 6 370 000 au lieu de 6 256 600.';
END
$$;

\echo ''
\echo '=== Tests 0002 termines ==='

ROLLBACK;
\echo ''
\echo 'Transaction annulee : la base de test reste vide.';