-- ===================================================================
-- AdkCars CI - 0004 : privileges de l'application
--
-- POURQUOI CETTE MIGRATION EXISTE
-- ===================================================================
-- Le CDCS 12.1 exige que l'application utilise un role RESTREINT,
-- distinct du role privilegie des migrations. Cette exigence etait
-- DOCUMENTEE mais jamais ACCORDEE : aucune migration ne contenait de
-- GRANT.
--
-- Consequence constatee : les 42 tables etaient propriete du role de
-- migration, le role applicatif n'avait AUCUN droit, et la moindre
-- requete echouait sur « permission denied for table user ». Le role
-- applicatif n'avait donc jamais fonctionne que par ACCIDENT, les
-- rares fois ou il se trouvait etre le proprietaire des tables.
--
-- Un accident n'est pas un controle de securite.
--
-- Cette migration rend la separation REELLE et VERIFIABLE, et elle est
-- testee par `tests/privileges.sql`.
--
-- -------------------------------------------------------------------
-- LE CONTRAT
-- -------------------------------------------------------------------
-- L'application doit pouvoir :
--   * lire et ecrire les donnees metier ;
--   * utiliser les sequences pour generer les identifiants ;
--   * executer les fonctions de la base (declencheurs, vues).
--
-- Elle NE DOIT PAS pouvoir :
--   * creer, supprimer ou modifier un objet du schema ;
--   * devenir proprietaire d'une table.
--
-- -------------------------------------------------------------------
-- PORTABILITE
-- -------------------------------------------------------------------
-- Sur Supabase, la chaine de connexion utilise par defaut le role
-- `postgres`, qui est proprietaire de tout : la separation n'y existe
-- pas d'elle-meme et doit etre CONSTRUITE. C'est ce que fait cette
-- migration, en declarant un role de groupe independant de la
-- plateforme.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Role de groupe applicatif
-- -------------------------------------------------------------------
-- NOLOGIN : ce n'est pas un compte, c'est un ensemble de droits. Un
-- compte de connexion se voit attribuer ce role, il ne le remplace
-- pas. Aucun mot de passe n'est defini ici, et aucun ne doit l'etre.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adkcars_app') THEN
    CREATE ROLE adkcars_app NOLOGIN;
  END IF;
END
$$;

COMMENT ON ROLE adkcars_app IS
  'Droits minimaux de l''application (CDCS 12.1). Role de groupe : '
  'NOLOGIN, sans mot de passe. Un compte de connexion doit en etre '
  'membre sans en heritage la propriete du schema.';

-- -------------------------------------------------------------------
-- 2. Droits sur les objets existants
-- -------------------------------------------------------------------
-- USAGE seule, jamais USAGE CREATE : creer des tables donnerait a
-- l'application la propriete d'objets que les migrations ne
-- controleraient plus. La creation reste reservee au role de migration.
GRANT USAGE ON SCHEMA public TO adkcars_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO adkcars_app;

-- Necessaires : plusieurs identifiants sont produits par `nextval` et
-- non par `gen_random_uuid`.
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO adkcars_app;

-- Les declencheurs sont des fonctions PL/pgSQL. Sans ce droit, la
-- premiere ecriture echoue sur « permission denied for function ».
GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA public
  TO adkcars_app;

-- -------------------------------------------------------------------
-- 3. Droits par defaut pour les MIGRATIONS SUIVANTES
-- -------------------------------------------------------------------
-- Sans ces clauses, toute table ajoutee par une migration future serait
-- inaccessible a l'application. L'oubli serait discret : la migration
-- reussirait, et l'echec n'apparaitrait qu'a la premiere requete sur la
-- nouvelle table, en production.
--
-- `ALTER DEFAULT PRIVILEGES` ne vaut que pour les objets cres par le
-- role qui l'execute : la clause doit donc etre portee par le role de
-- migration, pas par un autre.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adkcars_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO adkcars_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO adkcars_app;
