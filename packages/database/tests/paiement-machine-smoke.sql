-- ===================================================================
-- Tests de la migration 0008 : machine a etats du paiement
--
-- Verifie que les regles du paiement sont IMPOSEES PAR LA BASE, et pas
-- seulement autorisees par le code applicatif.
--
-- Rappel du risque : un `UPDATE` ne passe pas par le service. Une regle
-- qui n'est appliquee que par `assertPaymentTransition` protege le
-- processus, pas la donnee. Ces tests verifient qu'un `UPDATE` direct
-- est refuse par PostgreSQL.
-- ===================================================================

\set ON_ERROR_STOP on
BEGIN;

\echo ''
\echo '--- preparation : une reservation payable et des paiements ---'
DO $$
DECLARE
  owner_id uuid;
  cat_id uuid;
  veh_id uuid;
  booking_id uuid;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'owner2@test.ci';
  SELECT id INTO cat_id FROM vehicle_category WHERE slug = 'berline';

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model,
                       year, plate_number, transmission, fuel, seats,
                       daily_rate, currency_code, deposit_amount, status)
  VALUES ('owner', owner_id, cat_id, 'Peugeot', '301', 2023, 'PAY-T30',
          'manual', 'petrol', 5, 50000, 'XOF', 400000, 'published');
  SELECT id INTO veh_id FROM vehicle WHERE plate_number = 'PAY-T30';

  INSERT INTO booking (reference, client_id, provider_type, owner_id,
                       vehicle_id, start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, currency_code,
                       commission_rate, commission_source)
  SELECT 'PAY-1', u.id, 'owner', owner_id, veh_id,
         '2027-01-10 08:00+00', '2027-01-12 08:00+00', 'awaiting_payment',
         jsonb_build_object('version', 1, 'billedDays', 2,
                            'rentalAmount', 100000, 'depositAmount', 400000,
                            'dailyRateAtCreation', 50000),
         500000, 400000, 'XOF', 0.12, 'platform_default'
    FROM "user" u WHERE u.email = 'client@test.ci'
  RETURNING id INTO booking_id;

  PERFORM set_config('test.booking_id', booking_id::text, true);
END
$$;

-- -------------------------------------------------------------------
-- T31 : le parcours normal fonctionne, et `paid_at` se renseigne
-- -------------------------------------------------------------------
\echo ''
\echo '--- T31 : pending -> paid et la date d encaissement se pose seule ---'
DO $$
DECLARE
  b uuid;
  p uuid;
  horodatage timestamptz;
BEGIN
  b := current_setting('test.booking_id')::uuid;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (b, 'simulator', 'mobile_money', 'rental', 100000, 'XOF',
          'idem-t31')
  RETURNING id INTO p;

  UPDATE payment SET status = 'paid' WHERE id = p;

  SELECT paid_at INTO horodatage FROM payment WHERE id = p;

  IF horodatage IS NULL THEN
    RAISE EXCEPTION 'ECHEC T31 : paid_at non renseigne apres passage a paid';
  END IF;

  RAISE NOTICE 'OK T31 : pending -> paid autorise, paid_at pose automatiquement';
END
$$;

-- -------------------------------------------------------------------
-- T32 : LE TEST CENTRAL — on ne peut pas revenir en arriere
-- -------------------------------------------------------------------
-- C'est ce que la migration 0008 apporte. Avant elle, cet `UPDATE`
-- aboutissait : n'importe quelle voie d'ecriture pouvait faire repasser
-- un paiement encaisse en attente.
\echo ''
\echo '--- T32 : paid -> pending est refuse (regression du doublon) ---'
DO $$
DECLARE
  b uuid;
  p uuid;
BEGIN
  b := current_setting('test.booking_id')::uuid;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (b, 'simulator', 'mobile_money', 'rental', 100000, 'XOF',
          'idem-t32')
  RETURNING id INTO p;

  UPDATE payment SET status = 'paid' WHERE id = p;

  BEGIN
    UPDATE payment SET status = 'pending' WHERE id = p;
    RAISE EXCEPTION 'ECHEC T32 : un paiement encaisse a pu repasser en attente';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T32 : retour en arriere refuse — un webhook retransmis ne peut pas annuler un encaissement';
  END;
END
$$;

-- -------------------------------------------------------------------
-- T33 : pas de transition vers soi-meme
-- -------------------------------------------------------------------
-- `paid -> paid` est ABSENT de la table. C'est ce qui rend le doublon
-- DETECTABLE. L'inscrire comme transition legitime le rendrait
-- inoffensif, et l'idempotence se perdrait en silence.
\echo ''
\echo ''
\echo '--- T33 : ecriture identique sans effet, vraie transition refusee ---'
DO $$
DECLARE
  b uuid;
  p uuid;
BEGIN
  b := current_setting('test.booking_id')::uuid;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (b, 'simulator', 'card', 'rental', 100000, 'XOF', 'idem-t33')
  RETURNING id INTO p;

  UPDATE payment SET status = 'paid' WHERE id = p;

  -- 1. Reecrire le meme statut n'est pas une transition : c'est un
  --    no-op. Le module peut donc repeter son ecriture sans effet de
  --    bord, sans avoir a lire l'etat au prealable.
  --
  --    Refuser ici serait plus strict, mais obligerait chaque appelant a
  --    consulter avant d ecrire. Oublier cette lecture produirait une
  --    erreur chez un client qui a DEJA paye : une protection qui oblige
  --    a se tromper est une protection qu on contourne.
  BEGIN
    UPDATE payment SET status = 'paid' WHERE id = p;
    RAISE NOTICE 'OK T33 : ecriture de statut identique acceptee — le module peut repeter sans effet';
  END;

  -- 2. En revanche, une VRAIE transition depuis `paid` qui n'est pas le
  --    remboursement est refusee. `paid -> failed` n'a aucun sens, et
  --    l'accepter ferait disparaitre un paiement encaisse du comptabilise.
  BEGIN
    UPDATE payment SET status = 'failed' WHERE id = p;
    RAISE EXCEPTION 'ECHEC T33bis : un paiement encaisse a pu devenir failed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T33bis : paid -> failed refuse — un encaissement ne disparait pas';
  END;

  BEGIN
    UPDATE payment SET status = 'cancelled' WHERE id = p;
    RAISE EXCEPTION 'ECHEC T33ter : un paiement encaisse a pu etre annule';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T33ter : paid -> cancelled refuse';
  END;

  -- Le double COMPTAGE n'est pas la un probleme de transition : il est
  -- traite par le journal des notifications (T38). Le dire ici evite
  -- qu'on ne rajoute une regle qui ne servirait a rien.
  RAISE NOTICE 'OK T33quater : le double comptage est couvert par le journal (T38), pas par la transition';
END
$$;

\echo '--- T34 : failed -> pending, le reessai reste possible ---'
DO $$
DECLARE
  b uuid;
  p uuid;
BEGIN
  b := current_setting('test.booking_id')::uuid;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (b, 'simulator', 'mobile_money', 'rental', 100000, 'XOF',
          'idem-t34')
  RETURNING id INTO p;

  UPDATE payment SET status = 'failed', failure_code = 'INSUFFICIENT_FUNDS'
   WHERE id = p;

  UPDATE payment SET status = 'pending' WHERE id = p;
  UPDATE payment SET status = 'paid' WHERE id = p;

  IF (SELECT status FROM payment WHERE id = p) <> 'paid' THEN
    RAISE EXCEPTION 'ECHEC T34 : le reessai n aboutit pas';
  END IF;

  RAISE NOTICE 'OK T34 : echec puis reessai aboutis — pas de reservation a recreer';
END
$$;

-- -------------------------------------------------------------------
-- T35 : le remboursement est possible, et terminal
-- -------------------------------------------------------------------
\echo ''
\echo '--- T35 : paid -> refunded, puis plus rien ---'
DO $$
DECLARE
  b uuid;
  p uuid;
BEGIN
  b := current_setting('test.booking_id')::uuid;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (b, 'simulator', 'card', 'rental', 100000, 'XOF', 'idem-t35')
  RETURNING id INTO p;

  UPDATE payment SET status = 'paid' WHERE id = p;
  UPDATE payment SET status = 'refunded' WHERE id = p;

  BEGIN
    UPDATE payment SET status = 'paid' WHERE id = p;
    RAISE EXCEPTION 'ECHEC T35 : un paiement rembourse a pu redevenir paye';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T35 : refunded est terminal, conformement a la machine a etats';
  END;
END
$$;

-- -------------------------------------------------------------------
-- T36 : on ne peut pas encaisser une reservation annulee
-- -------------------------------------------------------------------
-- Scenario : le client annule pendant que la notification de paiement est
-- en vol. Le webhook arrive et dit `paid`. Sans cette regle, la
-- reservation passe de `cancelled_client` a `paid` et le client a paye
-- pour un vehicule qu'il n'aura pas.
\echo ''
\echo '--- T36 : encaissement refuse sur une reservation annulee ---'
DO $$
DECLARE
  owner_id uuid;
  veh_id uuid;
  booking_id uuid;
  p uuid;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'owner2@test.ci';

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model,
                       year, plate_number, transmission, fuel, seats,
                       daily_rate, currency_code, deposit_amount, status)
  SELECT 'owner', owner_id, c.id, 'Citroen', 'C3', 2023, 'PAY-T36',
         'manual', 'petrol', 5, 45000, 'XOF', 350000, 'published'
    FROM vehicle_category c WHERE c.slug = 'citadine';
  SELECT id INTO veh_id FROM vehicle WHERE plate_number = 'PAY-T36';

  INSERT INTO booking (reference, client_id, provider_type, owner_id,
                       vehicle_id, start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, currency_code,
                       commission_rate, commission_source)
  SELECT 'PAY-2', u.id, 'owner', owner_id, veh_id,
         '2027-02-10 08:00+00', '2027-02-12 08:00+00', 'awaiting_payment',
         jsonb_build_object('version', 1, 'billedDays', 2,
                            'rentalAmount', 90000, 'depositAmount', 350000,
                            'dailyRateAtCreation', 45000),
         440000, 350000, 'XOF', 0.12, 'platform_default'
    FROM "user" u WHERE u.email = 'client@test.ci'
  RETURNING id INTO booking_id;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (booking_id, 'simulator', 'mobile_money', 'rental', 90000, 'XOF',
          'idem-t36')
  RETURNING id INTO p;

  UPDATE booking SET status = 'cancelled_client', cancelled_at = now(),
                     cancel_reason = 'Le client a change d avis'
   WHERE id = booking_id;

  BEGIN
    UPDATE payment SET status = 'paid' WHERE id = p;
    RAISE EXCEPTION 'ECHEC T36 : un paiement a ete encaisse sur une reservation annulee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T36 : encaissement refuse apres annulation — demande un remboursement, pas un encaissement';
  END;
END
$$;

-- -------------------------------------------------------------------
-- T37 : la date d'encaissement ne peut pas flotter
-- -------------------------------------------------------------------
\echo ''
\echo '--- T37 : une date d encaissement sur un paiement non encaisse est refusee ---'
DO $$
DECLARE
  b uuid;
  p uuid;
BEGIN
  b := current_setting('test.booking_id')::uuid;

  INSERT INTO payment (booking_id, provider_key, method, kind, amount,
                       currency_code, idempotency_key)
  VALUES (b, 'simulator', 'card', 'rental', 100000, 'XOF', 'idem-t37')
  RETURNING id INTO p;

  BEGIN
    UPDATE payment SET status = 'pending', paid_at = now() WHERE id = p;
    RAISE EXCEPTION 'ECHEC T37 : une date d encaissement a ete posee sur un paiement en attente';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T37 : date d encaissement refusee hors etat paye — les rapprochements ne aberrent pas';
  END;
END
$$;

-- -------------------------------------------------------------------
-- T38 : l'idempotence des notifications est PERSISTANTE
-- -------------------------------------------------------------------
-- La machine a etats protege de la transition interdite ; elle ne
-- protege pas du traitement repete. C'est le role du journal : un
-- prestataire envoie au moins une fois, donc le doublon est la NORMALE,
-- pas l'exception.
\echo ''
\echo '--- T38 : un evenement de prestataire n est traite qu une fois ---'
DO $$
DECLARE
  -- ATTENTION : `sha256` prend un `bytea`, pas un `text`.
  -- Un transtypage `::text` de trop produit
  -- « function sha256(text) does not exist », et le message ne montre
  -- pas le type attendu — la seule piste est de savoir qu'il existe
  -- deux surcharges.
  charge bytea := convert_to('{""event"":""payment.paid""}', 'UTF8');
BEGIN
  -- Noter l evenement.
  INSERT INTO provider_webhook_delivery (provider_key, external_event_id,
                                         payload_sha256, processed_at,
                                         process_outcome)
  VALUES ('simulator', 'evt-001', encode(sha256(charge), 'hex'), now(),
          'applied');

  BEGIN
    INSERT INTO provider_webhook_delivery (provider_key, external_event_id,
                                           payload_sha256, processed_at,
                                           process_outcome)
    VALUES ('simulator', 'evt-001', encode(sha256(charge), 'hex'), now(),
            'applied');
    RAISE EXCEPTION 'ECHEC T38 : le meme evenement a ete enregistre deux fois';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK T38 : doublon refuse par contrainte unique — le traitement au plus une fois tient';
  END;

  -- Un evenement NON traite n'a pas de sanction, donc aucune
  -- contradiction possible : c'est ce qui permet de le retrouver.
  INSERT INTO provider_webhook_delivery (provider_key, external_event_id,
                                         payload_sha256)
  VALUES ('simulator', 'evt-002', encode(sha256(charge), 'hex'));

  -- 1. Une date de traitement SANS sanction est refusee. Une
  --    notification « traitee » sans issue ne se distingue plus d'une
  --    notification traitee avec succes : le journal devient incapable
  --    de dire ce qui s'est passe.
  BEGIN
    UPDATE provider_webhook_delivery
       SET processed_at = now()
     WHERE external_event_id = 'evt-002';
    RAISE EXCEPTION 'ECHEC T38bis : une date de traitement sans sanction a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T38bis : date de traitement sans sanction refusee';
  END;

  -- 2. Inversement, une sanction SANS date est refusee : sinon un
  --    evenement pourrait paraitre traite avant de l'etre.
  BEGIN
    UPDATE provider_webhook_delivery
       SET process_outcome = 'applied'
     WHERE external_event_id = 'evt-002';
    RAISE EXCEPTION 'ECHEC T38ter : une sanction sans date a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T38ter : sanction sans date refusee — rien ne parait traite avant de l etre';
  END;

  -- 3. Les deux ensemble passent : c'est la combinaison qui est
  --    coherente, pas chacune des moities.
  UPDATE provider_webhook_delivery
     SET processed_at = now(), process_outcome = 'ignored_duplicate'
   WHERE external_event_id = 'evt-002';

  RAISE NOTICE 'OK T38quater : date et sanction posees ensemble, ecriture acceptee';
END
$$;

-- -------------------------------------------------------------------
-- T39 : le catalogue ne peut pas diverger des contrats
-- -------------------------------------------------------------------
-- Le code applicatif autorise selon `PAYMENT_TRANSITIONS` ; la base
-- impose selon `payment_status_transition`. S'ils divergent,
-- l'application autorise ce que la base refuse, et l'utilisateur voit un
-- echec sans explication. Ni les tests unitaires ni les tests SQL ne
-- verraient l'ecart : chacun verifie son propre cote.
\echo ''
\echo '--- T39 : une transition fantome dans le catalogue est refusee ---'
DO $$
BEGIN
  BEGIN
    INSERT INTO payment_status_transition (from_status, to_status)
    VALUES ('paid', 'paid');
    RAISE EXCEPTION 'ECHEC T39 : une transition hors contrat a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T39 : divergence entre le catalogue et les contrats detectee a l ecriture';
  END;
END
$$;

ROLLBACK;
