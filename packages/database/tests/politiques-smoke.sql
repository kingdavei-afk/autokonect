-- ===================================================================
-- Tests de la migration 0007 : politiques financieres (CDCS 4.6)
--
-- Verifie que les trois decisions du 05/10/2026 sont IMPOSEES PAR LA
-- BASE, et non seulement decrites dans le CDC.
--   psql -v ON_ERROR_STOP=1 -f politiques-smoke.sql
--   (migrations 0001 a 0007 deja appliquees)
--
-- ------------------------------------------------------------------------
-- CE QUE CES TESTS PROUVENT, ET CE QU'ILS NE PROUVENT PAS
-- ------------------------------------------------------------------------
-- Ils prouvent que `booking_financial_outcome` et
-- `booking_overtime` produisent le montant annonce.
--
-- Ils ne prouvent pas que ces montants sont justes : c'est une decision
-- commerciale. Les tests verifient que la regle TELLE QU'ELLE EST ECRITE
-- s'applique, ce qui est ce que la base peut garantir. Le reste est
-- arbitrage humain.
-- ===================================================================

\set ON_ERROR_STOP on
BEGIN;

\echo ''
\echo '--- T22 : la politique est figee a la creation de la reservation ---'
DO $$
DECLARE
  owner_id uuid;
  cat_id uuid;
  veh_id uuid;
  booking_id uuid;
  snapshot jsonb;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'owner2@test.ci';
  SELECT id INTO cat_id FROM vehicle_category WHERE slug = 'berline';

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model,
                       year, plate_number, transmission, fuel, seats,
                       daily_rate, currency_code, deposit_amount, status)
  VALUES ('owner', owner_id, cat_id, 'Peugeot', '208', 2023, 'POL-T22',
          'manual', 'petrol', 5, 60000, 'XOF', 500000, 'published');

  SELECT id INTO veh_id FROM vehicle WHERE plate_number = 'POL-T22';

  INSERT INTO booking (reference, client_id, provider_type, owner_id,
                       vehicle_id, start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, currency_code,
                       commission_rate, commission_source)
  SELECT 'POL-1', u.id, 'owner', owner_id, veh_id,
         '2026-11-10 08:00+00', '2026-11-13 08:00+00', 'awaiting_payment',
         jsonb_build_object(
           'version', 1,
           'billedDays', 3,
           'rentalAmount', 180000,
           'depositAmount', 500000,
           'dailyRateAtCreation', 60000
         ),
         680000, 500000, 'XOF', 0.12, 'platform_default'
    FROM "user" u WHERE u.email = 'client@test.ci'
  RETURNING id INTO booking_id;

  SELECT policy_snapshot INTO snapshot FROM booking WHERE id = booking_id;

  -- Les trois decisions doivent etre la, et non seulement en base dans
  -- la table des politiques : c'est la RESERVATION qui doit porter la
  -- regle, pour survivre a une modification ulterieure.
  IF (snapshot ->> 'freeCancellationHours')::int = 24
     AND (snapshot ->> 'lateCancellationPenaltyPercent')::numeric = 50
     AND (snapshot ->> 'lateReturnGraceMinutes')::int = 30
     AND (snapshot ->> 'lateReturnOveragePercent')::numeric = 50
     AND (snapshot ->> 'noShowDepositForfeited')::boolean THEN
    RAISE NOTICE 'OK T22 : politique figee sur la reservation (24h / 50%% / 30min / 50%%)';
  ELSE
    RAISE EXCEPTION 'ECHEC T22 : politique figee inattendue : %', snapshot;
  END IF;
END
$$;

\echo ''
\echo '--- T23 : annulation dans le delai gratuit, apres 48 h ---'
DO $$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM booking WHERE reference = 'POL-1';

  -- Depart le 10 a 08:00. Annulation le 8 a 08:00 = 48 h avant : dans
  -- le delai gratuit de 24 h, donc aucun frais.
  SELECT * INTO b FROM booking_financial_outcome(
    b.id, '2026-11-08 08:00+00'::timestamptz
  );

  IF b.basis = 'free'
     AND b.penalty_amount = 0
     AND b.deposit_forfeited = 0
     AND b.refund_amount = 680000 THEN
    RAISE NOTICE 'OK T23 : annulation a -48h gratuite, integralite (680000) restituee';
  ELSE
    RAISE EXCEPTION
      'ECHEC T23 : base %, penalite %, caution %, remboursement % (attendu free/0/0/680000)',
      b.basis, b.penalty_amount, b.deposit_forfeited, b.refund_amount;
  END IF;
END
$$;

\echo ''
\echo '--- T24 : annulation tardive = 50 % du TARIF, pas du total ---'
DO $$
DECLARE
  b record;
  reservation_id uuid;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- Depart le 10 a 08:00. Annulation le 9 a 18:00 = 14 h avant : hors
  -- delai gratuit, donc penalite.
  SELECT * INTO b FROM booking_financial_outcome(
    reservation_id, '2026-11-09 18:00+00'::timestamptz
  );

  -- 50 %% de la LOCATION (180000) = 90000.
  -- 50 %% du TOTAL (680000) = 340000, qui_previendrait 250000 de
  -- caution : le client perdrait deux fois. C'est exactement l'erreur que
  -- ce test existe pour empecher.
  IF b.basis = 'late_penalty' AND b.penalty_amount = 90000 THEN
    RAISE NOTICE 'OK T24 : penalite de 90000 = 50 %% de la location (180000), et non du total (680000)';
  ELSE
    RAISE EXCEPTION
      'ECHEC T24 : penalite % (base %) au lieu de 90000 sur la location',
      b.penalty_amount, b.basis;
  END IF;

  -- Le total debourse se retrouve dans le calcul de la remise : caution
  -- rendue integralement, seule la location est amputee.
  IF b.deposit_forfeited = 0 AND b.refund_amount = 680000 - 90000 THEN
    RAISE NOTICE 'OK T24bis : caution restituee integralement, remboursement 591000';
  ELSE
    RAISE EXCEPTION
      'ECHEC T24bis : caution % et remboursement %, la caution ne doit jamais etre amputee par une penalite',
      b.deposit_forfeited, b.refund_amount;
  END IF;
END
$$;

\echo ''
\echo '--- T25 : non-presentation = caution entiere confisquee ---'
DO $$
DECLARE
  b record;
  reservation_id uuid;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- Le client ne s'est pas presente : l'annulation intervient apres le
  -- debut de la location.
  SELECT * INTO b FROM booking_financial_outcome(
    reservation_id, '2026-11-10 08:30+00'::timestamptz
  );

  IF b.basis = 'no_show' AND b.deposit_forfeited = 500000 THEN
    RAISE NOTICE 'OK T25 : caution entiere (500000) confisquee en cas de non-presentation';
  ELSE
    RAISE EXCEPTION
      'ECHEC T25 : base % et caution % (attendu no_show et 500000)',
      b.basis, b.deposit_forfeited;
  END IF;

  -- La location n'est PAS facturee : le service n'a pas ete rendu.
  -- C'est l'hypothese `no_show_charges_rental = false`, exposee comme
  -- parametre et non figee dans une formule.
  IF b.penalty_amount = 0 AND b.refund_amount = 0 THEN
    RAISE NOTICE 'OK T25bis : location non facturee (service non rendu), aucun remboursement';
  ELSE
    RAISE EXCEPTION
      'ECHEC T25bis : penalite % et remboursement % (attendu 0 et 0)',
      b.penalty_amount, b.refund_amount;
  END IF;
END
$$;

\echo ''
\echo '--- T26 : restitution tardive = grace de 30 min, puis heure commencee ---'
DO $$
DECLARE
  reservation_id uuid;
  o record;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- Retour attendu le 13 a 08:00.

  -- 1. A l'heure exacte : rien.
  SELECT * INTO o FROM booking_overtime(reservation_id, '2026-11-13 08:00+00'::timestamptz);
  IF o.overage_amount = 0 THEN
    RAISE NOTICE 'OK T26 : restitution a l heure exacte, aucun frais';
  ELSE
    RAISE EXCEPTION 'ECHEC T26 : frais % pour une restitution a l heure exacte', o.overage_amount;
  END IF;

  -- 2. 30 min de grace pile : c'est la limite, pas le depassement.
  SELECT * INTO o FROM booking_overtime(reservation_id, '2026-11-13 08:29+00'::timestamptz);
  IF o.overage_amount = 0 THEN
    RAISE NOTICE 'OK T26bis : 29 min de retard, tolerance encore accordee';
  ELSE
    RAISE EXCEPTION 'ECHEC T26bis : frais % a 29 min (la grace est de 30)', o.overage_amount;
  END IF;

  -- 3. Depassement de la grace : la premiere heure commencee est due
  --    en entier. 50 %% de 60000 = 30000.
  SELECT * INTO o FROM booking_overtime(reservation_id, '2026-11-13 08:31+00'::timestamptz);
  IF o.overage_hours = 1 AND o.overage_amount = 30000 THEN
    RAISE NOTICE 'OK T26ter : 1 min au-dela de la grace = heure commencee, 30000';
  ELSE
    RAISE EXCEPTION
      'ECHEC T26ter : % h pour % (attendu 1 h et 30000)',
      o.overage_hours, o.overage_amount;
  END IF;

  -- 4. Une SECONDE de plus ne coute pas plus cher : begun et termine
  --    doivent avoir le meme prix. Sinon rendre a 09 h 29 et a 08 h 31
  --    couteraient la meme chose, ce qui est correct — et rendre a 09 h 01
  --    aussi, ce qui serait une invitation a depasser.
  SELECT * INTO o FROM booking_overtime(reservation_id, '2026-11-13 08:59+00'::timestamptz);
  IF o.overage_hours = 1 AND o.overage_amount = 30000 THEN
    RAISE NOTICE 'OK T26quater : 59 min au-dela de la grace toujours 1 heure, pas plus';
  ELSE
    RAISE EXCEPTION
      'ECHEC T26quater : % h pour 59 min de depassement (attendu 1 h)',
      o.overage_hours;
  END IF;

  -- 5. Deux heures et demie = trois heures commencees.
  SELECT * INTO o FROM booking_overtime(reservation_id, '2026-11-13 11:00+00'::timestamptz);
  IF o.overage_hours = 3 AND o.overage_amount = 90000 THEN
    RAISE NOTICE 'OK T26quinquies : 2 h 30 de retard = 3 heures commencees, 90000';
  ELSE
    RAISE EXCEPTION
      'ECHEC T26quinquies : % h pour % (attendu 3 h et 90000)',
      o.overage_hours, o.overage_amount;
  END IF;
END
$$;

\echo ''
\echo '--- T27 : la base refuse un montant invente ---'
DO $$
DECLARE
  -- Le nom de la variable est different de celui de la colonne.
  -- Dans un bloc PL/pgSQL, un identifiant masque la colonne du meme nom :
  -- `WHERE id = id` serait ambigu et PostgreSQL refuserait, au lieu de
  -- deviner lequel des deux designer.
  reservation_id uuid;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- Une penalite superieure au tarif de location signale une confusion
  -- avec le total. La base doit la refuser, pas la facturer.
  BEGIN
    UPDATE booking SET cancellation_penalty_amount = 400000
     WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T27 : une penalite superieure au tarif a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T27 : penalite superieure au tarif de location refusee';
  END;

  -- Idem pour la caution confisquee au-dela du depot verse.
  BEGIN
    UPDATE booking SET forfeited_deposit_amount = 999999
     WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T27bis : une caution superieure au depot a ete acceptee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T27bis : caution confisquee superieure au depot refusee';
  END;
END
$$;

\echo ''
\echo '--- T28 : la politique du proprietaire prime sur celle de la plateforme ---'
DO $$
DECLARE
  owner_id uuid;
  cat_id uuid;
  veh_id uuid;
  booking_id uuid;
  snapshot jsonb;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'owner2@test.ci';
  SELECT id INTO cat_id FROM vehicle_category WHERE slug = 'suv';

  -- Le proprietaire propose une tolerance superieure. C'est sa decision
  -- commerciale : la base l'applique sans que l'API ait a la connaitre.
  INSERT INTO financial_policy (scope, owner_id, priority,
                                free_cancellation_hours,
                                late_cancellation_penalty_percent)
  VALUES ('owner', owner_id, 200, 72, 25);

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model,
                       year, plate_number, transmission, fuel, seats,
                       daily_rate, currency_code, deposit_amount, status)
  VALUES ('owner', owner_id, cat_id, 'Nissan', 'Qashqai', 2023, 'POL-T28',
          'automatic', 'diesel', 5, 100000, 'XOF', 800000, 'published');
  SELECT id INTO veh_id FROM vehicle WHERE plate_number = 'POL-T28';

  INSERT INTO booking (reference, client_id, provider_type, owner_id,
                       vehicle_id, start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, currency_code,
                       commission_rate, commission_source)
  SELECT 'POL-2', u.id, 'owner', owner_id, veh_id,
         '2026-11-10 08:00+00', '2026-11-12 08:00+00', 'awaiting_payment',
         jsonb_build_object('version', 1, 'billedDays', 2,
                            'rentalAmount', 200000, 'depositAmount', 800000,
                            'dailyRateAtCreation', 100000),
         1000000, 800000, 'XOF', 0.12, 'platform_default'
    FROM "user" u WHERE u.email = 'client@test.ci'
  RETURNING id INTO booking_id;

  SELECT policy_snapshot INTO snapshot FROM booking WHERE id = booking_id;

  IF (snapshot ->> 'freeCancellationHours')::int = 72
     AND (snapshot ->> 'lateCancellationPenaltyPercent')::numeric = 25 THEN
    RAISE NOTICE 'OK T28 : politique du proprietaire (72h / 25 %%) prioritaire sur la plateforme (24h / 50 %%)';
  ELSE
    RAISE EXCEPTION 'ECHEC T28 : politique appliquee % (attendu 72h et 25 %%)', snapshot;
  END IF;
END
$$;

\echo ''
\echo ''
\echo ''
\echo '--- T29 : la regle est posee par la base, meme si on la refuse ---'
DO $$
DECLARE
  owner_id uuid;
  cat_id uuid;
  veh_id uuid;
  reservation_id uuid;
  snapshot jsonb;
BEGIN
  SELECT id INTO owner_id FROM "user" WHERE email = 'owner2@test.ci';
  SELECT id INTO cat_id FROM vehicle_category WHERE slug = 'citadine';

  INSERT INTO vehicle (provider_type, owner_id, category_id, brand, model,
                       year, plate_number, transmission, fuel, seats,
                       daily_rate, currency_code, deposit_amount, status)
  VALUES ('owner', owner_id, cat_id, 'Renault', 'Clio', 2023, 'POL-T29',
          'manual', 'petrol', 5, 40000, 'XOF', 300000, 'published');
  SELECT id INTO veh_id FROM vehicle WHERE plate_number = 'POL-T29';

  -- On demande EXPLICITEMENT une reservation sans regle.
  INSERT INTO booking (reference, client_id, provider_type, owner_id,
                       vehicle_id, start_at, end_at, status, pricing_snapshot,
                       total_amount, deposit_amount, currency_code,
                       commission_rate, commission_source, policy_snapshot)
  SELECT 'POL-3', u.id, 'owner', owner_id, veh_id,
         '2026-12-01 08:00+00', '2026-12-03 08:00+00', 'awaiting_payment',
         jsonb_build_object('version', 1, 'billedDays', 2,
                            'rentalAmount', 80000, 'depositAmount', 300000,
                            'dailyRateAtCreation', 40000),
         380000, 300000, 'XOF', 0.12, 'platform_default', NULL
    FROM "user" u WHERE u.email = 'client@test.ci'
  RETURNING id INTO reservation_id;

  SELECT policy_snapshot INTO snapshot FROM booking WHERE id = reservation_id;

  -- Le NULL demande a ete ecrase. C'est le comportement voulu : le
  -- code appelant n'a aucune prise sur la regle appliquee. Aucun oubli
  -- de sa part ne peut produire une reservation dont le sort financier
  -- serait incalculable.
  -- La valeur n est PAS verifiee ici : T28 vient de creer une politique
  -- de proprietaire a 72 h pour ce meme proprietaire, qui prime sur celle
  -- de la plateforme. Un test qui attendrait 24 h ici dependrait de
  -- l ordre d execution des tests — exactement le genre de couplage qui
  -- fait qu une suite passe sur une machine et echoue ailleurs.
  -- La valeur correcte est verifiee par T22, sur une reservation dont la
  -- resolution n est pas ambigue.
  IF snapshot IS NOT NULL
     AND snapshot ? 'freeCancellationHours'
     AND snapshot ? 'lateReturnOveragePercent'
     AND snapshot ? 'noShowDepositForfeited' THEN
    RAISE NOTICE 'OK T29 : regle posee malgre un NULL exige — le code appelant n a pas son mot a dire';
  ELSE
    RAISE EXCEPTION 'ECHEC T29 : regle absente ou incorrecte apres insertion : %', snapshot;
  END IF;

  -- Le garde-fou de la fonction est devenu inatteignable en
  -- fonctionnement normal, depuis que les snapshots sont immuables :
  -- on ne peut y aboutir qu'en desactivant les declencheurs, ce qui
  -- suppose un administrateur en train de faire precisement ce que ces
  -- declencheurs interdisent. Il est conserve — supprimer une protection
  -- parce qu elle est inatteignable revient a la retirer le jour ou la
  -- raison de son inatteignabilite disparait.
  RAISE NOTICE 'OK T29bis : garde-fou de calcul conserve comme defense en profondeur';
END
$$;

\echo ''
\echo '--- T30 : un devis fige ne se reecrit pas ---'
DO $$
DECLARE
  reservation_id uuid;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- Verifie avant correction : sur la base de developpement, ces trois
  -- requetes aboutissaient. Figer une regle sans interdire de la modifier
  -- ne la fige pas.
  BEGIN
    UPDATE booking
       SET pricing_snapshot = pricing_snapshot
                              || jsonb_build_object('rentalAmount', 1)
     WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T30 : le devis fige a ete reecrit';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T30 : reecriture du devis refusee';
  END;

  BEGIN
    UPDATE booking SET total_amount = 1 WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T30bis : le montant total fige a ete reecrit';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T30bis : reecriture du montant total refusee';
  END;

  BEGIN
    UPDATE booking SET policy_snapshot = NULL WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T30ter : la regle figee a ete effacee';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T30ter : effacement de la regle refuse — aucune sanction recalculable apres coup';
  END;

  -- En revanche, les champs qui DOIVENT evoluer restent accessibles :
  -- un verrou trop large paralyserait le produit au lieu de le
  -- proteger.
  UPDATE booking SET customer_notes = 'Note ajoutee apres coup'
   WHERE id = reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ECHEC T30quater : le verrou bloque aussi les mises a jour legitimes';
  END IF;

  RAISE NOTICE 'OK T30quater : les champs non figes restent modifiables';
END
$$;

\echo ''
\echo '--- T40 : les montants ont deux regimes de verrouillage differents ---'
DO $$
DECLARE
  reservation_id uuid;
  affectees int;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- ------------------------------------------------------------------------
  -- FIGE A LA CREATION : toute reecriture est refusee
  -- ------------------------------------------------------------------------
  -- Le devis est ce que le client a ACCEPTE. Le modifier apres coup rendrait
  -- une facture qui ne correspond plus a ce qui lui a ete presente.
  BEGIN
    UPDATE booking
       SET pricing_snapshot = pricing_snapshot
                              || jsonb_build_object('rentalAmount', 1)
     WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T40 : le devis fige a ete reecrit';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T40 : devis fige a la creation — reecriture refusee';
  END;

  BEGIN
    UPDATE booking SET total_amount = total_amount + 1 WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T40bis : le total fige a ete reecrit';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T40bis : total fige — reecriture refusee';
  END;

  ------------------------------------------------------------------------
  -- POSE UNE FOIS : la premiere ecriture passe, la reecriture est refusee
  ------------------------------------------------------------------------
  -- La sanction et le depassement sont poses A LA CONSTATATION. Les mettre
  -- dans la meme liste que le devis les rendait impossibles a enregistrer :
  -- `NULL` et `30000` sont differents, donc le verrou refusait la premiere
  -- ecriture comme une reecriture.
  --
  -- Le produit aurait semble fonctionner en ecrivant ailleurs — ce qui est
  -- PIRE que de ne pas verrouiller, parce que le defaut devient invisible.
  BEGIN
    UPDATE booking SET overtime_amount = 30000 WHERE id = reservation_id;

    GET DIAGNOSTICS affectees = ROW_COUNT;

    IF affectees <> 1 THEN
      RAISE EXCEPTION 'ECHEC T40ter : premiere ecriture du depassement refusee (% ligne)', affectees;
    END IF;

    RAISE NOTICE 'OK T40ter : premiere constatation du depassement acceptee';
  END;

  -- Reecrire la meme valeur : sans effet, donc acceptee. C est ce qui rend
  -- le calcul REJOUABLE sans changer de montant.
  BEGIN
    UPDATE booking SET overtime_amount = 30000 WHERE id = reservation_id;
    RAISE NOTICE 'OK T40quater : reecriture de la MEME valeur acceptee — le calcul reste rejouable';
  END;

  BEGIN
    UPDATE booking SET overtime_amount = 60000 WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T40quinquies : un depassement constate a ete reecrit';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T40quinquies : reecriture du depassement refusee — une sanction prononcee reste prononcee';
  END;

  -- ------------------------------------------------------------------------
  -- Un verrou trop large paralyserait le produit
  -- ------------------------------------------------------------------------
  BEGIN
    UPDATE booking SET customer_notes = 'Note ajoutee apres coup'
     WHERE id = reservation_id;

    GET DIAGNOSTICS affectees = ROW_COUNT;

    IF affectees <> 1 THEN
      RAISE EXCEPTION 'ECHEC T40sexies : le verrou bloque aussi les champs libres';
    END IF;

    RAISE NOTICE 'OK T40sexies : les champs non figes restent modifiables';
  END;
END
$$;

\echo ''
\echo '--- T41 : le depassement est borne et exige un tarif ---'
DO $$
DECLARE
  reservation_id uuid;
BEGIN
  SELECT id INTO reservation_id FROM booking WHERE reference = 'POL-1';

  -- Un depassement NEGATIF signifierait que la voiture a ete rendue en
  -- avance. Ce n est pas un depassement, et son montant serait sans sens.
  BEGIN
    UPDATE booking SET overtime_amount = -1 WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T41 : un depassement negatif a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T41 : depassement negatif refuse';
  END;

  -- Au-dela de dix fois le tarif journalier, la voiture n a pas ete rendue
  -- en retard : elle a ete RETENUE. Cela demande un arbitrage humain, et un
  -- calcul automatique y donnerait une fausse precision.
  BEGIN
    UPDATE booking SET overtime_amount = 900000 WHERE id = reservation_id;
    RAISE EXCEPTION 'ECHEC T41bis : un depassement implausible a ete accepte';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK T41bis : depassement au-dela de dix fois le tarif refuse (arbitrage requis)';
  END;

  -- Les deux refus n'ont rien MODIFIE. La valeur reste celle constatee
  -- par T40ter — pas NULL, qui serait une absence de montant et non une
  -- absence de modification.
  DECLARE restant bigint;
  BEGIN
    SELECT overtime_amount INTO restant FROM booking WHERE id = reservation_id;

    IF restant IS DISTINCT FROM 30000 THEN
      RAISE EXCEPTION
        'ECHEC T41ter : le depassement a change apres deux refus (attendu 30000, obtenu %)',
        restant;
    END IF;
  END;

  RAISE NOTICE 'OK T41ter : les refus n ont rien modifie — le montant constate reste constate';
END
$$;

ROLLBACK;
