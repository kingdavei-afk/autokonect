-- ===================================================================
-- AdkCars CI - provisionnement du developpement local
--
-- Connexion attendue :  PGPASSWORD=adkcars_dev psql -U postgres
--
-- CDC 15.2 : deux bases isolees, jamais de donnees partagees entre
-- l'environnement de developpement et celui des tests.
-- ===================================================================

-- -------------------------------------------------------------------
-- Role applicatif (principe du moindre privilege, CDC 12.1)
--
-- Deux roles distincts, et la distinction n'est pas decorative :
--
--   adkcars      : un COMPTE de connexion. Membre de adkcars_app, il
--                  n'herite d'aucun privilege de propriete. C'est le
--                  role utilise par DATABASE_URL.
--
--   adkcars_app  : un ENSEMBLE de droits, cree par la migration 0004.
--                  NOLOGIN, sans mot de passe, jamais connectable
--                  directement.
--
-- L'application s'execute donc avec exactement les droits de
-- adkcars_app, et rien de plus. Le garde-fou de DatabaseModule, qui
-- refuse que DATABASE_URL soit identique a DIRECT_DATABASE_URL, ne
-- repose plus sur une separation implicite : elle existe en SQL et
-- elle est testee par tests/privileges.sql.
-- -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adkcars') THEN
    CREATE ROLE adkcars WITH LOGIN PASSWORD 'adkcars_dev';
  END IF;
END
$$;

ALTER ROLE adkcars WITH PASSWORD 'adkcars_dev';

-- -------------------------------------------------------------------
-- Base de developpement
--
-- PROPRIETAIRE = postgres, PAS adkcars. C'est un point delicat.
--
-- Le proprietaire d'une base est implicitement membre de
-- `pg_database_owner`, qui possede le schema `public` par defaut dans
-- PostgreSQL 15 et suivants. Une base creee `OWNER adkcars` donne donc
-- au role applicatif les pleins pouvoirs sur le schema : il peut creer
-- des tables, et devient proprietaire d'objets que les migrations ne
-- controlent plus.
--
-- Ce n'est pas theorique : c'est exactement ce qui s'est produit, et
-- la separation des privileges (CDCS 12.1) n'existait que sur le papier.
-- L'etait parce que la base avait ete recreee par `DROP SCHEMA CASCADE`,
-- qui change silencieusement le proprietaire du schema. Une separation
-- qui depend de l'historique des operations n'est pas une separation.
--
-- La base appartient donc au role de migration, et l'application
-- n'obtient ses droits que par adkcars_app.
-- -------------------------------------------------------------------
SELECT 'CREATE DATABASE adkcars_dev OWNER postgres ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'adkcars_dev')
\gexec

-- -------------------------------------------------------------------
-- Base de test : isolee, recreee a chaque execution de la suite
-- -------------------------------------------------------------------
SELECT 'CREATE DATABASE adkcars_test OWNER postgres ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'adkcars_test')
\gexec

-- -------------------------------------------------------------------
-- Extensions
--   uuid-ossp / pgcrypto : generation d'identifiants (CDC 9.2)
--   unaccent             : recherche insensible aux accents (CDC 11.9)
--   pg_trgm              : recherche approximative sur marque et modele
--   pg_stat_statements   : observabilite des requetes (CDC 11.8)
-- -------------------------------------------------------------------
\connect adkcars_dev
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\connect adkcars_test
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -------------------------------------------------------------------
-- Schema : proprietaire et droits, de facon explicite
--
-- Ces deux instructions rendent l'etat independant de la facon dont la
-- base a ete creee ou reinitialisee. C'est le point : un controle de
-- securite ne doit pas dependre de l'historique des operations.
-- -------------------------------------------------------------------
\connect adkcars_dev
ALTER SCHEMA public OWNER TO postgres;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

\connect adkcars_test
ALTER SCHEMA public OWNER TO postgres;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

\echo ''
\echo '=== Bases provisionnees ==='
\connect postgres
SELECT datname, pg_encoding_to_char(encoding) AS encodage
FROM pg_database
WHERE datname LIKE 'adkcars%'
ORDER BY datname;

\echo ''
\echo '=== Roles ==='
\echo 'adkcars      : compte de connexion utilise par DATABASE_URL'
\echo 'adkcars_app  : ensemble de droits minimal (NOLOGIN, sans mot de passe)'
\echo ''

-- Le compte DOIT adherer au role de droits, sinon il n'a rien : la
-- separation est alors reverifiable a chaque provisionnement.
SELECT 'adhesion : ' || r.rolname || ' -> ' || m.rolname AS lien
FROM pg_roles r
JOIN pg_auth_members am ON am.member = r.oid
JOIN pg_roles m ON m.oid = am.roleid
WHERE r.rolname = 'adkcars';