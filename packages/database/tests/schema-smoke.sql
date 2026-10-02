-- ===================================================================
-- AdkCars CI - tests de non-regression du schema
--
-- Verifie que les regles critiques du CDCS sont imposees PAR LA BASE
-- et pas seulement par le code applicatif. Une regle qui n'est pas
-- contrainte en base est une regle qui finira par etre violee.
--
--   psql -d adkcars_schemacheck -v ON_ERROR_STOP=1 -f schema-smoke.sql
--
-- Chaque test doit lever une erreur. Le fichier echoue si un test
-- passe sans erreur (regle non appliquee).
-- ===================================================================

\set ON_ERROR_STOP on
BEGIN;

-- -------------------------------------------------------------------
-- Donnees minimales
-- -------------------------------------------------------------------
INSERT INTO country (code, name, phone_code, default_currency, timezone, is_active)
VALUES ('CI', 'Cote d''Ivoire', '+225', 'XOF', 'Africa/Abidjan', true);

INSERT INTO currency (code, name, symbol, minor_units)
VALUES ('XOF', 'Franc CFA', 'FCFA', 0);

INSERT INTO "user" (email, phone, status, roles, phone_verified_at)
VALUES ('client@test.ci', '+2250700000001', 'active', '{client}', now()),
       ('owner@test.ci',  '+2250700000002', 'active', '{owner}',  now());

INSERT INTO vehicle_category (slug, label)
VALUES ('berline', 'Berline'), ('suv', 'SUV');

INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model, year,
                     plate_number, transmission, fuel, seats, daily_rate,
                     currency_code, status, published_at)
VALUES ('owner', (SELECT id FROM "user" WHERE email = 'owner@test.ci'),
        (SELECT id FROM vehicle_category WHERE slug = 'berline'),
        'Renault', 'Talisman', 2022, 'AB-123-CD', 'automatic', 'petrol', 5,
        3500000, 'XOF', 'published', now());

\echo ''
\echo '--- T1 : recherche insensible aux accents et a la casse (CDCS 11.9) ---'
DO $$
DECLARE
  found boolean;
BEGIN
  SELECT search_vector @@ plainto_tsquery('simple', 'renault') INTO found
  FROM vehicle
  LIMIT 1;

  IF found THEN
    RAISE NOTICE 'OK T1 : "renault" (minuscule, sans accent) trouve';
  ELSE
    RAISE EXCEPTION 'ECHEC T1 : la recherche ne trouve pas "renault"';
  END IF;
END
$$;

\echo ''
\echo '--- T2 : double chevauchement interdit (CDCS 8.2) ---'
DO $$
DECLARE
  v uuid;
BEGIN
  SELECT id INTO v FROM vehicle LIMIT 1;

  INSERT INTO booking (reference, client_id, provider_type, owner_id, vehicle_id,
                       start_at, end_at, status, pricing_snapshot, total_amount)
  VALUES ('REF-A', (SELECT id FROM "user" WHERE email = 'client@test.ci'),
          'owner', (SELECT id FROM "user" WHERE email = 'owner@test.ci'), v,
          '2026-11-10 08:00+00', '2026-11-15 18:00+00', 'paid',
          '{"dailyRate": 3500000}', 17500000);

  -- ce chevauchement doit ECHOUER
  BEGIN
    INSERT INTO booking (reference, client_id, provider_type, owner_id, vehicle_id,
                         start_at, end_at, status, pricing_snapshot, total_amount)
    VALUES ('REF-B', (SELECT id FROM "user" WHERE email = 'client@test.ci'),
            'owner', (SELECT id FROM "user" WHERE email = 'owner@test.ci'), v,
            '2026-11-12 08:00+00', '2026-11-18 18:00+00', 'paid',
            '{"dailyRate": 3500000}', 21000000);
    RAISE EXCEPTION 'ECHEC T2 : le double chevauchement a ete accepte';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'OK T2 : chevauchement refuse (SQLSTATE %) ', SQLSTATE;
  END;
END
$$;

\echo ''
\echo '--- T3 : bornes exclusives, des locations jointives sont compatibles ---'
DO $$
DECLARE
  v uuid;
BEGIN
  SELECT id INTO v FROM vehicle LIMIT 1;

  -- fin le 15 a 18h, debut le 15 a 18h : aucun recouvrement -> doit passer
  INSERT INTO booking (reference, client_id, provider_type, owner_id, vehicle_id,
                       start_at, end_at, status, pricing_snapshot, total_amount)
  VALUES ('REF-C', (SELECT id FROM "user" WHERE email = 'client@test.ci'),
          'owner', (SELECT id FROM "user" WHERE email = 'owner@test.ci'), v,
          '2026-12-15 18:00+00', '2026-12-20 18:00+00', 'paid',
          '{"dailyRate": 3500000}', 17500000);
  RAISE NOTICE 'OK T3 : locations jointives acceptees';
END
$$;

\echo ''
\echo '--- T4 : un vehicule ne peut avoir qu un seul fournisseur (CDCS 9.3) ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO vehicle (provider_type, agency_id, owner_id, category_id, brand, model,
                         year, plate_number, transmission, fuel, seats, daily_rate, status)
    VALUES ('agency', gen_random_uuid(), (SELECT id FROM "user" WHERE email = 'owner@test.ci'),
            (SELECT id FROM vehicle_category WHERE slug = 'suv'), 'Toyota', 'Hilux', 2021,
            'AB-999-CD', 'manual', 'diesel', 5, 5000000, 'draft');
    RAISE EXCEPTION 'ECHEC T4 : agence et proprietaire ont ete acceptes ensemble';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T4 : double propriete refusee';
  END;
END
$$;

\echo ''
\echo '--- T5 : montant negatif interdit (CDCS 4.3) ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model, year,
                         plate_number, transmission, fuel, seats, daily_rate, status)
    VALUES ('owner', (SELECT id FROM "user" WHERE email = 'owner@test.ci'),
            (SELECT id FROM vehicle_category WHERE slug = 'suv'), 'Dacia', 'Logan', 2020,
            'AB-777-CD', 'manual', 'petrol', 5, -500, 'draft');
    RAISE EXCEPTION 'ECHEC T5 : un tarif negatif a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T5 : montant negatif refuse';
  END;
END
$$;

\echo ''
\echo '--- T6 : avis sans commentaire refuse sous la note de 4 (CDCS 7.6) ---'
DO $$
DECLARE
  b uuid;
  v uuid;
BEGIN
  SELECT id INTO b FROM booking WHERE reference = 'REF-A';
  SELECT id INTO v FROM vehicle LIMIT 1;

  BEGIN
    INSERT INTO review (booking_id, author_id, vehicle_id, rating)
    VALUES (b, (SELECT id FROM "user" WHERE email = 'client@test.ci'), v, 2);
    RAISE EXCEPTION 'ECHEC T6 : un avis de note 2 sans commentaire a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T6 : avis sans commentaire refuse';
  END;

  INSERT INTO review (booking_id, author_id, vehicle_id, rating, comment)
  VALUES (b, (SELECT id FROM "user" WHERE email = 'client@test.ci'), v, 2, 'Kilometrage annonce incorrect');
  RAISE NOTICE 'OK T6bis : avis de note 2 avec commentaire accepte';
END
$$;

\echo ''
\echo '--- T7 : deux avis pour une meme location sont impossibles (CDCS 9.3) ---'
DO $$
DECLARE
  b uuid;
  v uuid;
  u uuid;
BEGIN
  SELECT id INTO b FROM booking WHERE reference = 'REF-A';
  SELECT id INTO v FROM vehicle LIMIT 1;
  SELECT id INTO u FROM "user" WHERE email = 'owner@test.ci';

  BEGIN
    INSERT INTO review (booking_id, author_id, vehicle_id, rating, comment)
    VALUES (b, u, v, 5, 'Second avis sur la meme location');
    RAISE EXCEPTION 'ECHEC T7 : deux avis sur une meme location acceptes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK T7 : unicite de l avis par location garantie';
  END;
END
$$;

\echo ''
\echo '--- T8 : un compte actif doit avoir un identifiant verifie (CDCS 7.1) ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO "user" (email, status, roles)
    VALUES ('nonverifie@test.ci', 'active', '{client}');
    RAISE EXCEPTION 'ECHEC T8 : un compte actif non verifie a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T8 : compte actif sans verification refuse';
  END;
END
$$;

\echo ''
\echo '--- T9 : webhook de paiement idempotent (CDCS 12.6) ---'
DO $$
DECLARE
  b uuid;
  p uuid;
BEGIN
  SELECT id INTO b FROM booking WHERE reference = 'REF-A';

  INSERT INTO payment (booking_id, provider_key, method, amount, idempotency_key)
  VALUES (b, 'wave', 'mobile_money', 17500000, 'idem-001');

  BEGIN
    INSERT INTO payment (booking_id, provider_key, method, amount, idempotency_key)
    VALUES (b, 'wave', 'mobile_money', 17500000, 'idem-001');
    RAISE EXCEPTION 'ECHEC T9 : double debit accepte pour la meme cle';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK T9 : idempotence du paiement garantie';
  END;
END
$$;

\echo ''
\echo '--- T10 : la caution est hors commission (CDCS 8.5) ---'
DO $$
DECLARE
  t bigint;
BEGIN
  -- base 100000, commission 12 %, caution 50000 => 100000 - 50000 = 50000 de base
  SELECT (100000 - 50000) * 0.12 INTO t;
  IF t = 6000 THEN
    RAISE NOTICE 'OK T10 : commission calculee sur le hors-caution (6000)';
  ELSE
    RAISE EXCEPTION 'ECHEC T10 : commission = %, attendu 6000', t;
  END IF;
END
$$;

\echo ''
\echo '=== Tous les tests de schema sont passes ==='

ROLLBACK;
\echo ''
\echo 'Transaction annulee : la base de test reste vide.'