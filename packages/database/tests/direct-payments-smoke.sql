-- ===================================================================
-- AdkCars CI - 0005 : paiements directs et creances de commission (A-20)
--
-- Ces tests verifient que les DEUX circuits financiers restent separes,
-- et surtout qu'ils ne peuvent pas se contaminer.
--
-- Le risque n'est pas un calcul faux, visible sur un releve. C'est une
-- creance creee sur une reservation payee par la plateforme : le
-- partenaire serait alors facture deux fois, et la seconde facture
-- serait la plus defendable des deux — celle que l'on presente comme un
-- encours legitime.
-- ===================================================================

\set ON_ERROR_STOP on
BEGIN;

\echo ''
\echo '=== 8. PAIEMENTS DIRECTS ET CREANCES (A-20) ==='

-- -------------------------------------------------------------------
-- T22 : un paiement direct ne cree AUCUN solde du
-- -------------------------------------------------------------------
-- C'est LA regle centrale de A-20. La plateforme n'a rien encaisse :
-- produire un `balance_due` la ferait reverser un montant qu'elle n'a
-- jamais eu.
\echo '--- T22 : un paiement direct ne cree aucun solde du ---'
DO $$
DECLARE
  proprietaire uuid;
  client_id    uuid;
  booking_id   uuid;
  solde        numeric;
  brut_direct  numeric;
  categorie    uuid;
  vehicule_id  uuid;
BEGIN
  INSERT INTO "user" (email, phone, password_hash, status, phone_verified_at)
  VALUES ('a20-proprietaire@test.ci', '+2250810000001', 'hash', 'active', now())
  RETURNING id INTO proprietaire;

  INSERT INTO "user" (email, phone, password_hash, status, phone_verified_at)
  VALUES ('a20-client@test.ci', '+2250710000001', 'hash', 'active', now())
  RETURNING id INTO client_id;

  -- `booking.vehicle_id` est NOT NULL : la reservation ne peut pas
  -- exister sans vehicule. Un seul vehicule suffit pour tous les tests.
  INSERT INTO vehicle_category (slug, label, sort_order)
  VALUES ('a20-test', 'Test A-20', 990)
  ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label
  RETURNING id INTO categorie;

  INSERT INTO vehicle (
    category_id, provider_type, owner_id, brand, model, year,
    plate_number, transmission, fuel, seats, daily_rate, deposit_amount, status
  )
  VALUES (
    categorie, 'owner', proprietaire, 'Marque', 'Modele', 2022,
    'A20-' || left(md5(random()::text), 6), 'manual', 'petrol', 5, 50000, 0, 'published'
  )
  RETURNING id INTO vehicule_id;

  -- Parametre de session : survit au DO qui le pose, comme les
  -- autres tests de la suite.
  PERFORM set_config('test.a20_vehicule', vehicule_id::text, true);

  INSERT INTO booking (
    reference, client_id, provider_type, owner_id, funds_channel, vehicle_id,
    start_at, end_at, status, pricing_snapshot, total_amount, deposit_amount,
    commission_rate, commission_source, ended_at
  )
  VALUES (
    'D20A' || left(md5(random()::text), 8),
    client_id, 'owner', proprietaire, 'direct',
    (SELECT NULLIF(current_setting('test.a20_vehicule', true), '')::uuid),
    '2027-01-10', '2027-01-13', 'completed',
    '{"total":300000}'::jsonb, 300000, 0,
    0.12, 'platform_default', '2027-01-13'
  )
  RETURNING id INTO booking_id;

  -- Le client paie en especes directement au loueur.
  INSERT INTO payment (booking_id, provider_key, method, kind, amount, status, paid_at)
  VALUES (booking_id, 'especes', 'cash', 'rental', 300000, 'paid', now());

  SELECT balance_due, gross_direct
  INTO solde, brut_direct
  FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = proprietaire;

  IF solde <> 0 THEN
    RAISE EXCEPTION
      'ECHEC T22 : un solde du de % a ete produit sur un paiement direct, alors que la plateforme n a rien encaisse',
      solde;
  END IF;

  IF brut_direct <> 300000 THEN
    RAISE EXCEPTION 'ECHEC T22 : brut direct % au lieu de 300000', brut_direct;
  END IF;

  -- La creance est creee par le service applicatif. On la cree ici
  -- pour verifier le circuit complet ; c'est le e2e qui verifie que le
  -- service le fait vraiment.
  INSERT INTO commission_receivable (
    provider_type, owner_id, booking_id, amount, commission_rate, status
  )
  VALUES ('owner', proprietaire, booking_id, 36000, 0.12, 'open');

  RAISE NOTICE 'OK T22 : aucun solde du sur un paiement direct (brut direct = %)', brut_direct;
END
$$;

-- -------------------------------------------------------------------
-- T23 : la creance de commission est bien due
-- -------------------------------------------------------------------
-- Le contre-test est indispensable : T22 pourrait « passer » en
-- produisant zero partout, ce qui satisferait la premiere assertion et
-- perdrait la commission. Les deux circuits doivent bouger ensemble.
\echo '--- T23 : une creance de commission est creee ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  creance numeric;
BEGIN
  SELECT sum(amount - settled_amount) INTO creance
  FROM commission_receivable
  WHERE provider_type = 'owner' AND owner_id = proprietaire;

  -- 300 000 x 12 % = 36 000
  IF creance IS NULL OR creance <> 36000 THEN
    RAISE EXCEPTION 'ECHEC T23 : creance de % attendue a 36000', COALESCE(creance, 0);
  END IF;

  RAISE NOTICE 'OK T23 : creance de commission de % (300 000 x 12 %%)', creance;
END
$$;

-- -------------------------------------------------------------------
-- T24 : les deux circuits ne sont jamais additionnes
-- -------------------------------------------------------------------
-- Le piege le plus couteux : poser une reservation payee par la
-- plateforme sur le MEME partenaire et additionner les deux circuits.
-- Chaque circuit resterait coherent, mais le total affiche serait faux
-- — et c'est ce total qui sert a piloter les reversements.
\echo '--- T24 : plateforme et direct restent separes ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  client_id    uuid := (SELECT id FROM "user" WHERE email = 'a20-client@test.ci');
  booking_id   uuid;
  solde        numeric;
  brut_platform numeric;
  brut_direct  numeric;
BEGIN
  INSERT INTO booking (
    reference, client_id, provider_type, owner_id, funds_channel, vehicle_id,
    start_at, end_at, status, pricing_snapshot, total_amount, deposit_amount,
    commission_rate, commission_source, ended_at
  )
  VALUES (
    'D20B' || left(md5(random()::text), 8),
    client_id, 'owner', proprietaire, 'platform',
    (SELECT NULLIF(current_setting('test.a20_vehicule', true), '')::uuid),
    '2027-02-10', '2027-02-13', 'completed',
    '{"total":500000}'::jsonb, 500000, 0,
    0.12, 'platform_default', '2027-02-13'
  )
  RETURNING id INTO booking_id;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount, status, paid_at)
  VALUES (booking_id, 'orange_money', 'mobile_money', 'rental', 500000, 'paid', now());

  SELECT balance_due, gross_platform, gross_direct
  INTO solde, brut_platform, brut_direct
  FROM provider_ledger
  WHERE provider_type = 'owner' AND provider_id = proprietaire;

  -- Le solde du ne porte QUE la reservation encaissee par la plateforme.
  IF solde <> 500000 THEN
    RAISE EXCEPTION
      'ECHEC T24 : solde du de % attendu a 500000 (le circuit direct doit en etre exclu)', solde;
  END IF;

  IF brut_platform <> 500000 OR brut_direct <> 300000 THEN
    RAISE EXCEPTION
      'ECHEC T24 : brut plateforme % et brut direct % (attendus 500000 et 300000, non fusionnes)',
      brut_platform, brut_direct;
  END IF;

  -- 800 000 : c'est exactement ce qu'il ne faut PAS voir dans une
  -- seule colonne de tresorerie.
  RAISE NOTICE
    'OK T24 : circuits separes (plateforme % encaisse, direct % jamais encaisse, fusion interdite = %)',
    brut_platform, brut_direct, brut_platform + brut_direct;
END
$$;

-- -------------------------------------------------------------------
-- T25 : le canal ne peut pas contredire les paiements
-- -------------------------------------------------------------------
-- Sans ce declencheur, une reservation `direct` payee par mobile money
-- produirait une creance alors que l'argent est deja passe par la
-- plateforme : le partenaire serait facture deux fois.
\echo '--- T25 : canal contredit par un paiement, refuse ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  client_id    uuid := (SELECT id FROM "user" WHERE email = 'a20-client@test.ci');
  booking_id   uuid;
BEGIN
  INSERT INTO booking (
    reference, client_id, provider_type, owner_id, funds_channel, vehicle_id,
    start_at, end_at, status, pricing_snapshot, total_amount, deposit_amount,
    commission_rate, commission_source, ended_at
  )
  VALUES (
    'D20C' || left(md5(random()::text), 8),
    client_id, 'owner', proprietaire, 'direct',
    (SELECT NULLIF(current_setting('test.a20_vehicule', true), '')::uuid),
    '2027-03-10', '2027-03-13', 'completed',
    '{}'::jsonb, 100000, 0,
    0.12, 'platform_default', '2027-03-13'
  )
  RETURNING id INTO booking_id;

  BEGIN
    INSERT INTO payment (booking_id, provider_key, method, kind, amount, status, paid_at)
    VALUES (booking_id, 'orange_money', 'mobile_money', 'rental', 100000, 'paid', now());

    RAISE EXCEPTION 'ECHEC T25 : un paiement par la plateforme a ete accepte sur une reservation en canal direct';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T25 : paiement par la plateforme refuse sur un canal direct';
  END;
END
$$;

\echo '--- T25bis : especes sur une reservation declaree plateforme, refuse ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  client_id    uuid := (SELECT id FROM "user" WHERE email = 'a20-client@test.ci');
  booking_id   uuid;
BEGIN
  INSERT INTO booking (
    reference, client_id, provider_type, owner_id, funds_channel, vehicle_id,
    start_at, end_at, status, pricing_snapshot, total_amount, deposit_amount,
    commission_rate, commission_source, ended_at
  )
  VALUES (
    'D20D' || left(md5(random()::text), 8),
    client_id, 'owner', proprietaire, 'platform',
    (SELECT NULLIF(current_setting('test.a20_vehicule', true), '')::uuid),
    '2027-04-10', '2027-04-13', 'completed',
    '{}'::jsonb, 100000, 0,
    0.12, 'platform_default', '2027-04-13'
  )
  RETURNING id INTO booking_id;

  BEGIN
    INSERT INTO payment (booking_id, provider_key, method, kind, amount, status, paid_at)
    VALUES (booking_id, 'especes', 'cash', 'rental', 100000, 'paid', now());

    RAISE EXCEPTION 'ECHEC T25bis : un paiement en especes a ete accepte sur une reservation declaree plateforme';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T25bis : paiement en especes refuse sur un canal plateforme';
  END;
END
$$;

-- -------------------------------------------------------------------
-- T26 : une seule creance par reservation
-- -------------------------------------------------------------------
-- Un second traitement du webhook ne doit pas creer une seconde dette.
\echo '--- T26 : une seule creance par reservation ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  booking_ref uuid;
  n bigint;
BEGIN
  SELECT id INTO booking_ref FROM booking WHERE reference LIKE 'D20A%' LIMIT 1;

  BEGIN
    INSERT INTO commission_receivable (
      provider_type, owner_id, booking_id, amount, commission_rate, status
    )
    VALUES ('owner', proprietaire, booking_ref, 36000, 0.12, 'open');

    RAISE EXCEPTION 'ECHEC T26 : une seconde creance a ete acceptee pour la meme reservation';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK T26 : une seconde creance sur la meme reservation est refusee';
  END;

  SELECT count(*) INTO n FROM commission_receivable WHERE booking_id = booking_ref;

  IF n <> 1 THEN
    RAISE EXCEPTION 'ECHEC T26 : % creances pour une reservation, 1 attendue', n;
  END IF;
END
$$;

-- -------------------------------------------------------------------
-- T27 : une creance ne peut pas etre reglee au-dela de son montant
-- -------------------------------------------------------------------
\echo '--- T27 : reglement borne au montant de la creance ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  cr uuid;
BEGIN
  SELECT id INTO cr FROM commission_receivable
  WHERE owner_id = proprietaire AND status = 'open' LIMIT 1;

  UPDATE commission_receivable SET settled_amount = amount WHERE id = cr;

  BEGIN
    UPDATE commission_receivable SET settled_amount = amount + 1 WHERE id = cr;
    RAISE EXCEPTION 'ECHEC T27 : un reglement superieur au montant de la creance a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T27 : un reglement au-dela de la creance est refuse';
  END;
END
$$;

-- -------------------------------------------------------------------
-- T28 : une creance ne peut pas disparaitre sans trace
-- -------------------------------------------------------------------
-- Un abandon de creance est une decision commerciale et doit rester
-- visible. Une creance supprimee par cascade ferait disparaitre une
-- perte de chiffre d'affaires sans qu'aucun releve ne la montre.
\echo '--- T28 : une creance ne peut pas etre supprimee ---'
DO $$
DECLARE
  proprietaire uuid := (SELECT id FROM "user" WHERE email = 'a20-proprietaire@test.ci');
  cr uuid;
BEGIN
  SELECT id INTO cr FROM commission_receivable
  WHERE owner_id = proprietaire LIMIT 1;

  BEGIN
    DELETE FROM commission_receivable WHERE id = cr;
    RAISE EXCEPTION 'ECHEC T28 : une creance a pu etre supprimee';
  EXCEPTION WHEN check_violation THEN
    -- L'exception est une violation de contrainte, comme pour les
    -- autres regles : le declencheur leve avec le code 23514.
    RAISE NOTICE 'OK T28 : la suppression directe d une creance est bloquee';
  END;

  -- Le chemin declare doit fonctionner : c'est lui qui remplace la
  -- suppression, et il doit rester la seule issue.
  UPDATE commission_receivable
  SET status = 'written_off', written_off_reason = 'Test A-20'
  WHERE id = cr;

  IF NOT EXISTS (
    SELECT 1 FROM commission_receivable WHERE id = cr AND status = 'written_off'
  ) THEN
    RAISE EXCEPTION 'ECHEC T28 : l abandon declare n a pas ete accepte';
  END IF;

  RAISE NOTICE 'OK T28bis : l abandon par statut reste possible et trace';
END
$$;

\echo ''
\echo '=== Tests 0005 termines ==='

ROLLBACK;
\echo ''
\echo 'Transaction annulee : la base de test reste vide.';
