-- ===================================================================
-- AdkCars CI - 0009 : un remboursement ne peut pas depasser l encaisse
--
-- Ce que cette migration fait : elle rend impossible de rembourser plus
-- que ce qui a ete reellement encaisse.
-- ===================================================================
--
-- POURQUOI LA GARDE EST DANS LA BASE ET PAS DANS LE SERVICE
-- ===================================================================
-- `booking_financial_outcome` calcule le sort financier d une annulation
-- a partir du DEVIS FIGE de la reservation : tarif de location, caution
-- annoncee, taux de sanction. Le devis porte ce que le client a
-- ACCEPTE, pas ce que la plateforme a ENCAISSE.
--
-- Les deux ne coincident pas encore. L arbitrage A-04 (capture de la
-- caution) n'est pas arbitre, donc la caution n est pas encaissee : le
-- module ne collecte que le montant de location. Un remboursement calcule
-- sur le devis rendrait donc de l argent que personne n a jamais donne.
--
-- Le service peut borner le montant par le total encaisse. Il peut
-- aussi l oublier — dans une annulation, une correction, un litige, ou
-- le prochain module ecrit par quelqu un d autre. C est exactement ce
-- qui est arrive avec les transitions de paiement (migration 0008) :
-- la regle existait en TypeScript, et un `UPDATE` direct la contournait.
--
-- Alors la borne est ici, ou elle s applique a toute voie d ecriture.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Le montant rembourse ne depasse pas le montant encaisse
-- -------------------------------------------------------------------
-- Le controle porte sur le PAIEMENT, pas sur la reservation : c est lui
-- qui porte l argent. Deux paiements distincts pour une meme reservation
-- sont normaux — un client qui a echoue puis reessaye — et les borner
-- par la reservation confondrait deux paiements legitimement
-- distincts en un seul.
CREATE FUNCTION guard_refund_against_collected()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  encaisse bigint;
  statut text;
  deja_rembourse bigint;
  total bigint;
BEGIN
  SELECT p.amount, p.status
    INTO encaisse, statut
    FROM payment p
   WHERE p.id = NEW.payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'refund_payment_absente: le remboursement % reference le paiement % qui n existe pas',
      NEW.id, NEW.payment_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- On ne rembourse que ce qui a ete ENCAISSE. Rembourser un paiement
  -- annule ou en echec promet-trait de l argent qui n existe pas.
  IF statut <> 'paid' AND statut <> 'refunded' THEN
    RAISE EXCEPTION
      'refund_not_collected: le remboursement % porte sur le paiement % au statut % ; un remboursement suppose un encaissement',
      NEW.id, NEW.payment_id, statut
      USING ERRCODE = 'check_violation';
  END IF;

  -- Les remboursements ANTERIEURS sont pris en compte : deux
  -- remboursements partiels successifs ne doivent pas pouvoir depasser
  -- le total, chacun se croyant seul.
  SELECT coalesce(sum(r.amount), 0)
    INTO deja_rembourse
    FROM refund r
   WHERE r.payment_id = NEW.payment_id
     AND r.id <> NEW.id
     AND r.status IN ('pending', 'succeeded');

  total := deja_rembourse + NEW.amount;

  IF total > encaisse THEN
    RAISE EXCEPTION
      'refund_exceeds_collected: le total rembourse sur le paiement % serait % alors que % ont ete encaisses. Un remboursement ne peut pas depasser la collecte.',
      NEW.payment_id, total, encaisse
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_refund_01_against_collected
  BEFORE INSERT OR UPDATE ON refund
  FOR EACH ROW
  EXECUTE FUNCTION guard_refund_against_collected();

COMMENT ON FUNCTION guard_refund_against_collected() IS
  'Un remboursement ne peut pas depasser ce qui a ete encaisse sur le '
  'paiement concerne. Le devis fige porte ce que le client a ACCEPTE, pas '
  'ce qui a ete ENCAISSE : les deux ne coincident pas tant que A-04 (capture '
  'de la caution) n est pas arbitre.';

-- -------------------------------------------------------------------
-- 2. La sanction ne peut pas depasser la location
-- -------------------------------------------------------------------
-- Migration 0007 : deja pose pour `booking.cancellation_penalty_amount`.
-- Ce rappel est volontaire — la regle existe, elle s applique, et une
-- regle financiere qu on ne peut pas rappeler finit par etre enfreinte
-- par quelqu un qui l ignore.
--
-- `paid -> pending` refuse par la base : la regle financiere la plus
-- importante du module tient sur un declencheur, pas sur une discipline.
-- Meme exigence ici.
--
-- Ce que la migration 0007 NE pose PAS, et que cette section ne pose pas
-- non plus : qu une reservation `paid` ait un paiement encaisse. Avec
-- A-20, le canal `direct` facture la commission a part, et le moment de
-- la confirmation depend d A-04. Enoncer la regle maintenant serait la
-- deviner.

-- -------------------------------------------------------------------
-- 3. Le journal des sanctions doit etre consultable
-- -------------------------------------------------------------------
-- Une sanction appliquee sans trace n est pas une sanction, c est un
-- montant qui disparait. La colonne existe (migration 0007) ; ce qui
-- manquait etait la possibilite de la LIRE sans connaitre le schema.
CREATE VIEW booking_financial_settlement AS
SELECT
  b.id AS booking_id,
  b.reference,
  b.status,
  b.start_at,
  b.end_at,
  b.currency_code,
  -- Les montants du devis FIGE, tels que le client les a acceptes.
  (b.pricing_snapshot ->> 'rentalAmount')::bigint AS rental_amount,
  b.total_amount,
  b.deposit_amount,
  -- Ce qui a reellement bouge.
  coalesce(b.cancellation_penalty_amount, 0) AS penalty_amount,
  coalesce(b.forfeited_deposit_amount, 0) AS deposit_forfeited,
  coalesce(
    (
      SELECT sum(p.amount)
        FROM payment p
       WHERE p.booking_id = b.id AND p.status = 'paid'
    ),
    0
  ) AS collected_amount,
  coalesce(
    (
      SELECT sum(p.amount)
        FROM payment p
       WHERE p.booking_id = b.id AND p.status = 'paid' AND p.kind = 'deposit'
    ),
    0
  ) AS deposit_collected,
  coalesce(
    (
      SELECT sum(r.amount)
        FROM refund r
       WHERE r.payment_id IN (
         SELECT p.id FROM payment p WHERE p.booking_id = b.id
       ) AND r.status IN ('pending', 'succeeded')
    ),
    0
  ) AS refunded_amount,
  -- Regle affichee comme CONTRAINTte de restitution : jamais moins que
  -- ce qui a ete paye, jamais plus que ce qui a ete encaisse.
  greatest(
    0,
    coalesce(
      (
        SELECT sum(p.amount)
          FROM payment p
         WHERE p.booking_id = b.id AND p.status = 'paid'
      ),
      0
    )
    - coalesce(b.cancellation_penalty_amount, 0)
    - coalesce(b.forfeited_deposit_amount, 0)
    - coalesce(
        (
          SELECT sum(r.amount)
            FROM refund r
           WHERE r.payment_id IN (
             SELECT p.id FROM payment p WHERE p.booking_id = b.id
           ) AND r.status IN ('pending', 'succeeded')
        ),
        0
      )
  ) AS net_to_restitue
FROM booking b;

COMMENT ON VIEW booking_financial_settlement IS
  'Reglement financier d une reservation : ce qui a ete accepte, ce qui a '
  'ete encaisse, ce qui a etre sanctionne, et le net a restituer. '
  'Le net est borne par la collecte — jamais de remboursement au-dela de '
  'ce qui a ete paye, meme si le devis l autoriserait.';

-- -------------------------------------------------------------------
-- 4. La vue doit voir l annulation
-- -------------------------------------------------------------------
-- `booking_financial_outcome` calcule le montant ATTENDU pour une
-- annulation a une date donnee. La vue donne le montant REELLEMENT
-- applique. Les deux doivent concorder ; la vue est donc interrogeable
-- sans connaitre la fonction, ce qui evite d avoir a reimplementer son
-- calcul dans un rapport.
CREATE FUNCTION booking_expected_cancellation(p_booking uuid)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT (booking_financial_outcome(p_booking, now())).penalty_amount
$$;
