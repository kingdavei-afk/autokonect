-- ===================================================================
-- AdkCars CI - 0006 : donnees de reference
--
-- CE QUE CETTE MIGRATION REPARE
-- ===================================================================
-- Aucune migration ne semait les devises. La table `currency` etait
-- vide sur une base neuve, alors que `vehicle.currency_code` y renvoie
-- par cle etrangere avec une valeur par defaut a 'XOF'.
--
-- Consequence, verifiee : sur une base creee par les seules migrations,
-- la creation d'un vehicule echoue sur
--
--     insert or update on table "vehicle" violates foreign key
--     constraint "vehicle_currency_code_fkey"
--
-- C'est un defaut qui ne se voit qu'en环境和ation sur un environnement
-- neuf : les tests passaient parce que `fixtures.sql` semait la devise
-- et que la base de developpement avait ete creee avant la migration
-- qui l'a videe. Ni l'un ni l'autre n'est une garantie.
--
-- Une base de production doit etre reproductible par les seules
-- migrations. Sinon le deploiement depend de l'historique d'un
-- environnement, ce qui est exactement ce qu'on ne veut pas.
--
-- -------------------------------------------------------------------
-- POURQUOI SEULEMENT LA DEVISE
-- ===================================================================
-- `vehicle_category`, `plan` et `setting` sont laissees vides, et c'est
-- deliberé :
--
--   * `setting` contient la configuration PLATEFORME (taux de
--     commission par defaut, drapeaux). C'est un choix commercial, pas
--     une donnee technique : il doit etre fixe par un operateur, pas
--     impose par le code. Les migrations 0002 et 0003 en ont deja pose
--     des valeurs, mais elles restent lisibles et modifiables.
--
--   * `plan` est le catalogue commercial des formules d'abonnement. Le
--     remplir par defaut creerait des formules facturées a de vrais
--     clients alors que personne ne les a vendues.
--
--   * `vehicle_category` appartient au referentiel metier, pas au
--     moteur : une categorie ajoutee par un administrateur ne doit pas
--     disparaitre au prochain deploiement.
-- ===================================================================

-- -------------------------------------------------------------------
-- Devises
-- -------------------------------------------------------------------
-- ⚠️ `minor_units` porte TOUTE la semantique de l'argent (CDCS 4.3).
--
-- XOF = 0 : l'unite stockee EST le franc. `3 500 000` vaut trois
-- millions cinq cents mille francs CFA, PAS 35 000. Poser 2 par
-- reflexe — parce que c'est ce que fait l'euro — afficherait des
-- prix vingt fois trop bas, et l'erreur serait undetectable a la
-- relecture du code.
INSERT INTO currency (code, name, symbol, minor_units)
VALUES
  ('XOF', 'Franc CFA (UEMOA)', 'FCFA', 0),
  ('EUR', 'Euro', '€', 2)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      symbol = EXCLUDED.symbol,
      minor_units = EXCLUDED.minor_units;

COMMENT ON TABLE currency IS
  'Devises autorisees. `minor_units` determine la semantique de tous '
  'les montants (CDCS 4.3) : XOF vaut 0, donc l unite stockee est le '
  'franc. Ne pas modifier cette valeur sans migration, tout le code en '
  'depend.';

-- -------------------------------------------------------------------
-- Garde-fou : la devise par defaut doit exister
-- -------------------------------------------------------------------
-- Le `DEFAULT 'XOF'` des colonnes ne verifie rien : PostgreSQL ne
-- controle la cle etrangere qu'a l'ecriture. Sans ce controle, une
-- suppression accidentelle de XOF laisserait le schema valide et
-- toutes les insertions en echec, sans message explicite.
DO $$
DECLARE
  attendu constant text := 'XOF';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM currency WHERE code = attendu) THEN
    RAISE EXCEPTION
      'devise par defaut % absente : vehicules et reservations ne peuvent pas etre crees.',
      attendu
      USING ERRCODE = '23514';
  END IF;
END
$$;
