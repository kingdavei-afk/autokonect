-- ===================================================================
-- AdkCars CI - 0010 : le dépassement de restitution (CDCS 4.6, A-21)
--
-- Ce que cette migration fait : elle rend le depassement CONSTANT, pas
-- recalcule, et elle fournit l'heure de restitution a partir de laquelle
-- le calculer.
-- ===================================================================
--
-- -------------------------------------------------------------------
-- POURQUOI UNE COLONNE ET NON UNE FONCTION A CHAQUE LECTURE
-- -------------------------------------------------------------------
-- `booking_overtime(booking, returned_at)` sait deja calculer. On
-- pourrait l'appeler dans chaque rapport et dans chaque echeque.
--
-- Ce serait une erreur. Le depassement est un MONTANT RECLAMABLE AU
-- CLIENT : il doit pouvoir etre conteste, et un montant qui change
-- selon l'heure a laquelle on pose la question n'est pas contestable.
-- Il est donc fige au moment ou la restitution est constatee — comme le
-- devis, et pour la meme raison.
--
-- Le reliquat du calcul est lui aussi fige : l'heure de retour. Un
-- depassement recalcule demain, apres que `end_at` aurait ete corrige,
-- ne serait plus le montant prononce.
--
-- -------------------------------------------------------------------
-- L HEURE DE RESTITUTION : CE QUI EXISTE, ET CE QUI MANQUE
-- -------------------------------------------------------------------
-- `handover.performed_at` est l'heure REELLE de restitution. C est la
-- seule source fiable : `ended_at` est l'heure a laquelle quelqu un a
-- DECLARE que la voiture etait rendue, ce qui peut etre des heures
-- apres.
--
-- Aucun module de remise n'existe encore — la table est vide. La
-- fonction ci-dessous lit donc `handover` quand elle existe, et se
-- replie sur `ended_at` sinon.
--
-- Ce n'est pas une approximation qu on Assume : c'est un repli
-- DECLARE, et le code applicatif signale que le module manque. Le jour
-- ou la remise sera enregistree, le calcul changera — vers plus juste —
-- sans qu aucune migration ni reecriture ne soit necessaire.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. L'heure de restitution
-- -------------------------------------------------------------------
CREATE FUNCTION booking_return_time(p_booking uuid)
RETURNS timestamptz
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    -- La remise constatee prime : c'est l'heure ou le vehicule est
    -- revenu.
    (
      SELECT h.performed_at
        FROM handover h
       WHERE h.booking_id = p_booking
         AND h.kind = 'return'
       ORDER BY h.performed_at DESC
       LIMIT 1
    ),
    -- Repli : l'heure a laquelle la fin de location a ete enregistree.
    b.ended_at
  )
  FROM booking b
   WHERE b.id = p_booking
$$;

COMMENT ON FUNCTION booking_return_time(uuid) IS
  'Heure de restitution. La remise constatee prime sur ended_at, qui est '
  'l heure d une DECLARATION et non d un fait. Aucun module de remise '
  'n existant encore : la table handover est vide, donc le repli s '
  'applique. Il ne disparaitra pas de lui-meme quand le module arrivera.';

-- -------------------------------------------------------------------
-- 2. Le depassement, fige
-- -------------------------------------------------------------------
ALTER TABLE booking
  ADD COLUMN overtime_amount bigint;

COMMENT ON COLUMN booking.overtime_amount IS
  'Depassement de restitution FIGE (CDCS 4.6, A-21). 30 min de grace, '
  'puis chaque heure commencee a 50 % du tarif journalier. '
  'Fige : un montant reclamable au client doit etre contestable, et un '
  'montant qui change selon l heure de la question ne l est pas. '
  'En euros : ce qui reste du apres deduction de la caution — ce qui '
  'suppose A-04.';

-- -------------------------------------------------------------------
-- 3. Un depassement ne peut pas etre negatif ni absurde
-- -------------------------------------------------------------------
-- Un depassement negatif signifierait que le vehicule a ete rendu en
-- avance — ce qui n est pas un depassement, et dont le montant serait
-- sans sens.
--
-- Le plafond est le tarif journalier * 10. Au-dela, le vehicule a ete
-- retenu bien plus longtemps qu une retenue prolongee : c est soit une
-- omission de saisie, soit un litige, et dans les deux cas le montant
-- doit etre arbitre, pas calcule.
CREATE FUNCTION check_overtime_plausibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tarif bigint;
  plafond bigint;
BEGIN
  IF NEW.overtime_amount IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.overtime_amount < 0 THEN
    RAISE EXCEPTION
      'overtime_negative: le depassement de la reservation % ne peut pas etre negatif (%)',
      NEW.id, NEW.overtime_amount
      USING ERRCODE = 'check_violation';
  END IF;

  tarif := (NEW.pricing_snapshot ->> 'dailyRateAtCreation')::bigint;

  IF tarif IS NULL THEN
    RAISE EXCEPTION
      'overtime_without_rate: la reservation % n a pas de tarif journalier fige ; le depassement ne peut pas etre borne',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Dix fois le tarif journalier. Au-dela, ce n est plus un retard de
  -- restitution mais une retenue : elle demande un arbitrage humain, et
  -- un calcul automatique donnerait une fausse precision.
  plafond := tarif * 10;

  IF NEW.overtime_amount > plafond THEN
    RAISE EXCEPTION
      'overtime_implausible: le depassement de la reservation % (%) depasse dix fois le tarif journalier (%). Une retenue aussi longue demande un arbitrage, pas un calcul.',
      NEW.id, NEW.overtime_amount, plafond
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_booking_02_overtime_plausibility
  BEFORE INSERT OR UPDATE ON booking
  FOR EACH ROW
  EXECUTE FUNCTION check_overtime_plausibility();
-- -------------------------------------------------------------------
-- 4. Le depassement est fige comme le devis
-- -------------------------------------------------------------------
-- Migration 0007 : les snapshots ne se reecrivent pas. Le depassement
-- releve de la meme logique — c est un montant annonce au client, donc
-- contestable, donc fige.
--
-- La regle doit devenir MOINS large a mesure que les montants
-- s ajoutent, pas plus large. Un trigger deja ecrit qui ignore une
-- colonne ajoutee apres coup est une porte ouverte qu on ne voit pas.
--
-- Le trigger et la fonction sont donc recrees plutot que elargis sur
-- place : une fonction ne peut pas etre supprimee sous un trigger, et
-- la sequence par renommages echouait sur ce detail.
DROP TRIGGER trg_booking_snapshot_immutable ON booking;
DROP FUNCTION prevent_booking_snapshot_rewrite();

CREATE FUNCTION prevent_booking_amount_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- Montants FIGES a la creation. Toute reecriture est refusee : ce
  -- sont ceux que le client a ACCEPTE.
  fige constant text[] := ARRAY[
    'pricing_snapshot', 'policy_snapshot', 'total_amount', 'deposit_amount'
  ];

  -- Montants POSES UNE FOIS, a la constatation. Ils passent de NULL a
  -- une valeur, puis ne bougent plus : la sanction prononcee doit rester
  -- celle qui a ete prononcee.
  pose_une_fois constant text[] := ARRAY[
    'cancellation_penalty_amount', 'forfeited_deposit_amount', 'overtime_amount'
  ];

  champ text;
  ancien text;
  nouveau text;
BEGIN
  FOREACH champ IN ARRAY fige LOOP
    ancien := to_jsonb(OLD) ->> champ;
    nouveau := to_jsonb(NEW) ->> champ;

    IF ancien IS DISTINCT FROM nouveau THEN
      RAISE EXCEPTION
        'reservation % : % est fige a la creation (% -> %) et ne peut pas etre reecrit. Corriger passe par une annulation puis une nouvelle reservation.',
        NEW.id, champ, coalesce(ancien, 'vide'), coalesce(nouveau, 'vide')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  FOREACH champ IN ARRAY pose_une_fois LOOP
    ancien := to_jsonb(OLD) ->> champ;
    nouveau := to_jsonb(NEW) ->> champ;

    -- Seule la REECRITURE d une valeur deja posee est refusee.
    --
    -- `NULL -> valeur` est la premiere constatation : elle doit passer,
    -- sinon la sanction et le depassement ne pourraient jamais etre
    -- enregistres — et le produit semblerait fonctionner en ecrivant
    -- ailleurs, ce qui est pire que de ne pas verrouiller du tout.
    IF ancien IS NOT NULL AND ancien IS DISTINCT FROM nouveau THEN
      RAISE EXCEPTION
        'reservation % : % a deja ete constate a % et ne peut pas devenir %. Une sanction prononcee doit rester celle qui a ete prononcee.',
        NEW.id, champ, ancien, coalesce(nouveau, 'vide')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_booking_amount_immutable
  BEFORE UPDATE ON booking
  FOR EACH ROW
  EXECUTE FUNCTION prevent_booking_amount_rewrite();

COMMENT ON FUNCTION prevent_booking_amount_rewrite() IS
  'Devis, regle et depassement sont figures a la creation ou a la '
  'constatation. Corriger passe par une annulation puis une nouvelle '
  'reservation : un acte metier trace, visible des deux parties, et non '
  'une retouche invisible.';
-- -------------------------------------------------------------------
-- 5. Ce que cette migration NE fait PAS
-- -------------------------------------------------------------------
-- **Elle ne preleve pas le depassement sur la caution.** A-04 (capture de
-- la caution) n est pas arbitre : la caution n est pas encaissee. Le
-- depassement est donc CALCULE et FIGE, mais sa Perception ne peut pas
-- s appuyer sur une caution inexistante.
--
-- Il devient une dette du client, recouvrable par tout moyen a venir —
-- ce qui est un circuit financier que A-04 doit decrire.
--
-- **Elle ne cree pas de creance.** `commission_receivable` (migration
-- 0005) est specifique aux commissions de la plateforme. Un depassement
-- n en est pas une : creer un second circuit sans arbitrage serait
-- inventer une regle de tresorerie.
--
-- Les deux sont notes ici pour que leur absence soit un choix consigne,
-- et non un oubli.