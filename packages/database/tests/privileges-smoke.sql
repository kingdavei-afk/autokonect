-- ===================================================================
-- AdkCars CI - contrats de privileges (CDCS 12.1)
--
-- Ces tests s'executent en se connectant avec le role APPLICATIF, et
-- non avec le role de migration. C'est la seule maniere de verifier
-- qu'un privilege est reellement refuse : un test qui tourne en
-- superuser ne prouve rien.
--
-- Chaque refus est teste positivement. « Je n'ai pas essaye » ne prouve
-- pas qu'une operation est impossible.
-- ===================================================================

-- -------------------------------------------------------------------
-- P1 : le role applicatif peut LIRE
-- -------------------------------------------------------------------
\echo '--- P1 : lecture des donnees metier ---'
DO $$
DECLARE
  n bigint;
BEGIN
  -- Passe par `adkcars_app` plutot que par le compte : c'est le role de
  -- droits qui porte le contrat, quel que soit le compte connecte.
  SET ROLE adkcars_app;
  SELECT count(*) INTO n FROM "user";
  RESET ROLE;

  RAISE NOTICE 'OK P1 : lecture de la table user autorisee (%)', n;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'ECHEC P1 : la lecture metier est refusee : %', SQLERRM;
END
$$;

-- -------------------------------------------------------------------
-- P2 : le role applicatif peut ECRIRE
-- -------------------------------------------------------------------
\echo '--- P2 : ecriture ---'
DO $$
DECLARE
  uid uuid;
BEGIN
  SET ROLE adkcars_app;

  -- `phone_verified_at` est pose : la regle metier « actif implies
  -- verifie » refuse sinon l'insertion. Ce declencheur sert
  -- involontairement de test supplementaire -- s'il s'execute, c'est
  -- que le role applicatif a bien le droit d'executer les fonctions.
  INSERT INTO "user" (email, phone, password_hash, status, phone_verified_at)
  VALUES ('privileges@test.ci', '+2250102030405', 'hash-de-test', 'active', now())
  RETURNING id INTO uid;

  -- Le declencheur `updated_at` doit s'executer aussi.
  UPDATE "user" SET status = 'suspended' WHERE id = uid;

  DELETE FROM "user" WHERE id = uid;

  RESET ROLE;

  RAISE NOTICE 'OK P2 : insertion, modification et suppression autorisees';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'ECHEC P2 : l ecriture est refusee : %', SQLERRM;
END
$$;

-- -------------------------------------------------------------------
-- P3 : le role applicatif NE PEUT PAS creer de table
-- -------------------------------------------------------------------
-- C'est le privilege le plus important de cette suite. Une application
-- capable de creer ses propres tables devient proprietaire d'objets que
-- les migrations ne controlent plus : le schema derive en silence, et
-- aucune comparaison entre environments ne le revele.
\echo '--- P3 : creation de table refusee ---'
DO $$
BEGIN
  SET ROLE adkcars_app;

  BEGIN
    CREATE TABLE privileges_ne_doit_pas_exister (id integer);
    RAISE EXCEPTION 'ECHEC P3 : la creation de table a reussi';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK P3 : creation de table refusee';
  END;

  RESET ROLE;
END
$$;

-- -------------------------------------------------------------------
-- P4 : le role applicatif NE PEUT PAS supprimer une table
-- -------------------------------------------------------------------
-- Verifie sur une table REELLE : un `DROP ... IF EXISTS` sur une table
-- inexistante ne prouverait rien, il ne produirait qu'un avertissement.
\echo '--- P4 : suppression de table refusee ---'
DO $$
BEGIN
  SET ROLE adkcars_app;

  BEGIN
    DROP TABLE booking;
    RAISE EXCEPTION 'ECHEC P4 : la suppression d une table a reussi';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK P4 : suppression de table refusee';
  END;

  RESET ROLE;
END
$$;

-- -------------------------------------------------------------------
-- P5 : le role applicatif NE PEUT PAS modifier le schema
-- -------------------------------------------------------------------
\echo '--- P5 : alteration de table refusee ---'
DO $$
BEGIN
  SET ROLE adkcars_app;

  BEGIN
    ALTER TABLE booking ADD COLUMN privileges_colonne_interdite integer;
    RAISE EXCEPTION 'ECHEC P5 : l alteration de table a reussi';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK P5 : alteration de table refusee';
  END;

  RESET ROLE;
END
$$;

-- -------------------------------------------------------------------
-- P6 : le role applicatif NE PEUT PAS lire les mots de passe
-- -------------------------------------------------------------------
-- `pg_shadow` contient les hachages de mots de passe de tous les roles.
-- Un acces en lecture serait une fuite totale, pas une commodite.
\echo '--- P6 : catalogue systeme inaccessible ---'
DO $$
BEGIN
  SET ROLE adkcars_app;

  BEGIN
    PERFORM 1 FROM pg_shadow;
    RAISE EXCEPTION 'ECHEC P6 : pg_shadow est lisible';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK P6 : pg_shadow inaccessible';
  END;

  RESET ROLE;
END
$$;

-- -------------------------------------------------------------------
-- P7 : le role de droits ne peut PAS se connecter
-- -------------------------------------------------------------------
-- `adkcars_app` est NOLOGIN. S'il pouvait se connecter, il deviendrait
-- un second compte applicatif, sans aucun moyen de le distinguer ni de
-- le desactiver.
\echo '--- P7 : le role de droits n est pas connectable ---'
DO $$
DECLARE
  connectable boolean;
BEGIN
  SELECT rolcanlogin INTO connectable
  FROM pg_roles WHERE rolname = 'adkcars_app';

  IF connectable THEN
    RAISE EXCEPTION 'ECHEC P7 : adkcars_app est NOLOGIN attendu, LOGIN trouve';
  END IF;

  RAISE NOTICE 'OK P7 : adkcars_app est NOLOGIN, comme attendu';
END
$$;

-- -------------------------------------------------------------------
-- P8 : le role de droits n'est proprietaire d'aucune table
-- -------------------------------------------------------------------
\echo '--- P8 : aucune propriete sur les tables ---'
DO $$
DECLARE
  propriete bigint;
BEGIN
  SELECT count(*) INTO propriete
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'S', 'v', 'm')
    AND pg_get_userbyid(c.relowner) = 'adkcars_app';

  -- Etre proprietaire, meme sans privilege directe, permet de
  -- supprimer l'objet. C'est le trou que ce test ferme.
  IF propriete > 0 THEN
    RAISE EXCEPTION
      'ECHEC P8 : adkcars_app est proprietaire de % objet(s)', propriete;
  END IF;

  RAISE NOTICE 'OK P8 : aucune table n appartient au role applicatif';
END
$$;

\echo ''
\echo '=== Todos les tests de privileges sont passes ==='
