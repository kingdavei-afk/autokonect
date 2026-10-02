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
-- -------------------------------------------------------------------
SELECT 'CREATE DATABASE adkcars_dev OWNER adkcars ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'adkcars_dev')
\gexec

-- -------------------------------------------------------------------
-- Base de test : isolee, recreee a chaque execution de la suite
-- -------------------------------------------------------------------
SELECT 'CREATE DATABASE adkcars_test OWNER adkcars ENCODING ''UTF8'''
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

\echo ''
\echo '=== Bases provisionnees ==='
\connect postgres
SELECT datname, pg_encoding_to_char(encoding) AS encodage
FROM pg_database
WHERE datname LIKE 'adkcars%'
ORDER BY datname;

\echo ''
\echo '=== Role applicatif ==='
\echo 'adkcars / adkcars_dev  (proprietaire, usage developpement uniquement)'