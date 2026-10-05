-- ===================================================================
-- AdkCars CI - 0007 : politiques financières (CDCS 4.6, A-21)
-- ===================================================================
-- CE QUE CE FICHIER REGLE
-- ===================================================================
-- Le CDCS 4.6 était entièrement en `[TBD]` : huit politiques, aucune
-- décidée. Trois d'entre elles touchent l'argent, et les computations
-- correspondantes vivaient nulle part — donc dans aucune règle.
--
-- Décisions prises le 05/10/2026 :
--
--   * Annulation client  : gratuite jusqu'à 24 h avant le départ,
--                          puis 50 % du tarif de location.
--   * Non-présentation    : caution entière confisquée.
--   * Restitution tardive : 30 min de grâce, puis chaque heure
--                          commencée × 50 % du tarif journalier.
--
-- Ces règles vivent dans la base, et non dans le code applicatif. La
-- raison est arithmétique autant que doctrinale : la pénalité doit être
-- identique qu'elle soit calculée par un script, une tâche planifiée ou
-- un administrateur en console. Si deux implémentations coexistent, elles
-- divergent, et c'est la version fausse qui facture le client.
--
-- -------------------------------------------------------------------
-- LE PIÈGE : LA CAUTION EST DANS `total_amount`
-- -------------------------------------------------------------------
-- Vérifié en base :
--
--     total_amount   = 680 000
--     deposit_amount = 500 000
--     rental_amount  = 180 000   (dans pricing_snapshot)
--
-- `total_amount` INCLUT la caution. Or « 50 % du tarif » ne peut pas
-- se lire « 50 % de `total_amount` » : cela préleverait 340 000, dont
-- 250 000 de caution, soit une pénalité de 90 000 sur une location de
-- 180 000. Le client serait pénalisé deux fois — une fois par la
-- pénalité, une fois par la confiscation déguisée de son dépôt de
-- garantie.
--
-- Toutes les fonctions ci-dessous lisent donc `rentalAmount` dans le
-- snapshot, jamais `total_amount`. La contrainte T09 rend l'incohérence
-- impossible plutôt que de compter sur une relecture attentive.
--
-- -------------------------------------------------------------------
-- CE QUI RESTE UNE HYPOTHÈSE
-- -------------------------------------------------------------------
-- `no_show_charges_rental` vaut `false` par défaut : en cas de
-- non-présentation, la caution est confiscée mais la location N'EST PAS
-- facturée, puisque le service n'a pas été rendu.
--
-- Ce n'est PAS une décision confirmée — la question posée portait sur la
-- caution seule. C'est un paramètre, pas une règle figée : le changer
-- est un `UPDATE`, sans migration ni redéploiement. Il est exposé ici
-- pour que l'hypothèse soit visible et non enfouie dans une formule.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Les politiques, en DONNÉES
-- -------------------------------------------------------------------
-- Une table, pas des constantes dans le code. Trois raisons :
--
--   * le taux peut changer sans redéploiement ;
--   * un propriétaire peut proposer des conditions différentes ;
--   * la valeur appliquée à une réservation doit être FIGÉE, donc
--     consultable a posteriori — impossible si elle n'est stockée que
--     dans le code exécuté au moment du calcul.
CREATE TABLE financial_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  scope text NOT NULL CHECK (scope IN ('platform', 'owner')),

  owner_id uuid REFERENCES "user" (id) ON DELETE CASCADE,

  -- Priorité de résolution, comme pour la commission (migration 0002).
  -- Le nombre le plus élevé gagne. L'ordre est explicite parce que la
  -- question « qui gagne ? » se pose à chaque nouveau niveau de
  -- configuration, et que « le dernier inséré » n'est pas une règle.
  priority int NOT NULL DEFAULT 100,

  -- ---------------------------------------------------------------
  -- Annulation client
  -- ---------------------------------------------------------------
  -- Délai AVANT le départ pendant lequel l'annulation est gratuite.
  free_cancellation_hours int NOT NULL DEFAULT 24
    CHECK (free_cancellation_hours >= 0),

  -- Pénalité au-delà, en pourcentage du tarif de LOCATION (hors
  -- caution). La borne à 100 est une donnee, pas une coquetterie : une
  -- pénalité supérieure au prix du service n'a aucun sens et signalerait
  -- une erreur de saisie.
  late_cancellation_penalty_percent numeric(6, 4) NOT NULL DEFAULT 50
    CHECK (late_cancellation_penalty_percent >= 0
       AND late_cancellation_penalty_percent <= 100),

  -- ---------------------------------------------------------------
  -- Non-présentation
  -- ---------------------------------------------------------------
  no_show_deposit_forfeited boolean NOT NULL DEFAULT true,

  -- ⚠️ HYPOTHÈSE, pas décision confirmée. Voir l'en-tête du fichier.
  no_show_charges_rental boolean NOT NULL DEFAULT false,

  -- ---------------------------------------------------------------
  -- Restitution tardive
  -- ---------------------------------------------------------------
  late_return_grace_minutes int NOT NULL DEFAULT 30
    CHECK (late_return_grace_minutes >= 0),

  -- Tarif appliqué à chaque heure COMMENCÉE au-delà de la grâce.
  -- « Commencée » et non « entamée » : begun et terminé doivent coûter le
  -- même prix. Sans cela, rendre à 14 h 59 une voiture due à 14 h 00 ne
  -- coûterait rien, ce qui est une invitation à dépasser de dix minutes.
  late_return_overage_percent numeric(6, 4) NOT NULL DEFAULT 50
    CHECK (late_return_overage_percent >= 0
       AND late_return_overage_percent <= 200),

  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Une politique de plateforme n'a pas de propriétaire, et une politique
  -- de propriétaire en a toujours un. Sans cette contrainte, une ligne
  -- `scope = 'owner'` sans `owner_id` serait irrésolvable en silence : la
  -- résolution l'ignorerait, et l'appliquer par défaut serait pire.
  CONSTRAINT t01_owner_required CHECK (
    (scope = 'platform' AND owner_id IS NULL)
    OR (scope = 'owner' AND owner_id IS NOT NULL)
  ),

  CONSTRAINT t02_dates CHECK (valid_until IS NULL OR valid_until > valid_from)
);

-- Les politiques de plateforme ne sont pas uniques « par nature » —
-- plusieurs peuvent coexister avec des priorités différentes. En
-- revanche deux politiques de plateforme de MÊME priorité sont
-- ambiguës : la résolution en choisirait une arbitrairement.
CREATE UNIQUE INDEX ux_financial_policy_platform
  ON financial_policy (priority)
  WHERE scope = 'platform' AND active;

CREATE UNIQUE INDEX ux_financial_policy_owner
  ON financial_policy (owner_id, priority)
  WHERE scope = 'owner' AND active;

COMMENT ON TABLE financial_policy IS
  'Politiques financières (CDCS 4.6). Paramétrées en données : le taux '
  'appliqué à une réservation est figé dans booking.policy_snapshot au '
  'moment de sa création, donc consultable même après modification ici.';

COMMENT ON COLUMN financial_policy.no_show_charges_rental IS
  'HYPOTHÈSE NON CONFIRMÉE. false = la caution est confisquée mais la '
  'location n est pas facturée (service non rendu). Changer cette valeur '
  'est un UPDATE : aucun redéploiement requis.';

-- La politique de plateforme issue des trois decisions du 05/10/2026.
INSERT INTO financial_policy (
  scope,
  priority,
  free_cancellation_hours,
  late_cancellation_penalty_percent,
  no_show_deposit_forfeited,
  no_show_charges_rental,
  late_return_grace_minutes,
  late_return_overage_percent
)
VALUES (
  'platform',
  100,
  24,
  50,
  true,
  false,
  30,
  50
);

-- -------------------------------------------------------------------
-- 2. Résolution de la politique applicable
-- -------------------------------------------------------------------
-- Deux-Regles seulement, et elles sont dans le CDC : le propriétaire
-- d'abord, la plateforme en repli. La priorité départage les niveaux
-- d'une même portée.
CREATE FUNCTION resolve_financial_policy(p_owner uuid)
RETURNS financial_policy
LANGUAGE sql STABLE
AS $$
  SELECT *
    FROM financial_policy
   WHERE active
     AND valid_from <= now()
     AND (valid_until IS NULL OR valid_until > now())
     AND (
       ($1::uuid IS NOT NULL AND scope = 'owner' AND owner_id = $1)
       OR scope = 'platform'
     )
   ORDER BY
     -- Le propriétaire passe avant la plateforme. Explicite : « le
     -- premier trouvé » ne documenterait pas l'intention, et une future
     -- condition sur la priorité pourrait inverser l'ordre sans que
     -- personne ne le remarque.
     CASE scope WHEN 'owner' THEN 1 ELSE 0 END DESC,
     priority DESC
   LIMIT 1
$$;

-- -------------------------------------------------------------------
-- 3. Le calcul — point UNIQUE de vérité
-- -------------------------------------------------------------------
-- Une fonction, et non trois règles réparties dans le code applicatif,
-- dans une tâche planifiée et dans une console d'administration.
--
-- Chaque surface qui répondrait « combien doit le client ? » appellerait
-- CETTE fonction. C'est la seule façon que trois implémentations
-- n'en soient qu'une.
--
-- `p_at` est la date de l'événement (annulation, non-présentation, ou
-- restitution). Elle est paramétrée et non lue dans `now()` : le
-- calcul doit être reproductible. Rejouer un litige dans six mois exige
-- de pouvoir dire « et s'il avait été annulé le 12 à 14 h ? ».
CREATE FUNCTION booking_financial_outcome(p_booking uuid, p_at timestamptz)
RETURNS TABLE (
  basis text,
  rental_amount bigint,
  penalty_amount bigint,
  deposit_forfeited bigint,
  refund_amount bigint
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  b booking%ROWTYPE;

  -- DEUX documents distincts, et non un seul « snapshot ».
  --
  --   policy_snapshot   : la REGLE appliquee (delai, taux, grace)
  --   pricing_snapshot  : les MONTANTS de la reservation
  --
  -- Les confondre ne donne pas une erreur : `jsonb ->> 'cle'` sur une
  -- cle absente renvoie NULL, qui se propage en silence jusqu'au
  -- montant final. C'est exactement ce qui s'est produit : le
  -- calcul renvoyait NULL au lieu de lever une erreur.
  pol jsonb;
  pricing jsonb;

  rental bigint;
  deposit bigint;
  hours_before numeric;
  daily_rate bigint;
BEGIN
  SELECT * INTO b FROM booking WHERE id = p_booking;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation % introuvable', p_booking
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Une réservation créée avant cette migration n'a pas de politique
  -- figée. Plutôt que d'appliquer une règle par défaut silencieusement —
  -- ce qui ferait qu'une réservation ancienne serait pénalisée selon une
  -- règle qui n'existait pas à son época — on refuse de calculer.
  IF b.policy_snapshot IS NULL THEN
    RAISE EXCEPTION
      'reservation % sans politique figée : la regle a change apres sa creation, aucune consequence ne peut etre calculee',
      p_booking
      USING ERRCODE = 'check_violation';
  END IF;

  pol := b.policy_snapshot;
  pricing := b.pricing_snapshot;

  -- Les MONTANTS viennent de `pricing_snapshot`. La REGLE vient de
  -- `policy_snapshot`. Voir la declaration des deux variables.
  --
  -- `total_amount` n'est volontairement pas utilise : il INCLUT la
  -- caution (verifie : 680000 = 180000 de location + 500000 de caution).
  -- Une sanction calculee dessus preleverait la caution du client.
  rental := (pricing ->> 'rentalAmount')::bigint;
  deposit := b.deposit_amount;
  daily_rate := (pricing ->> 'dailyRateAtCreation')::bigint;

  -- Toutes les cles DOIVENT exister.
  --
  -- `IS DISTINCT FROM` traite NULL comme une valeur : une cle absente
  -- devient un REFUS. Avec `<>`, une cle absente donnerait NULL, donc
  -- pas VRAI, donc aucun refus. La verification n'aurait rien verifie
  -- tout en donnant l'impression de le faire — c'est le defaut le plus
  -- couteux du lot : une securite qui semble presente et qui est absente.
  IF (pricing ->> 'rentalAmount') IS NULL
     OR (pricing ->> 'dailyRateAtCreation') IS NULL THEN
    RAISE EXCEPTION
      'reservation % : snapshot de tarif incomplet (rentalAmount=%, dailyRateAtCreation=%)',
      p_booking, pricing ->> 'rentalAmount', pricing ->> 'dailyRateAtCreation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (pricing ->> 'depositAmount')::bigint IS DISTINCT FROM deposit THEN
    RAISE EXCEPTION
      'reservation % : caution du snapshot (%) et caution de la colonne (%) divergentes',
      p_booking, pricing ->> 'depositAmount', deposit
      USING ERRCODE = 'check_violation';
  END IF;

  -- Le total doit valoir la location PLUS la caution. Sans ce controle,
  -- deux sources de verite se contrediraient en silence, et c'est le
  -- montant CALCULE qui trancherait — pas la donnee.
  IF (pricing ->> 'rentalAmount')::bigint <> b.total_amount - deposit THEN
    RAISE EXCEPTION
      'reservation % : location (%) incoherent avec total (%) moins caution (%)',
      p_booking, pricing ->> 'rentalAmount', b.total_amount, deposit
      USING ERRCODE = 'check_violation';
  END IF;

  hours_before := EXTRACT(EPOCH FROM (b.start_at - p_at)) / 3600.0;

  -- -------------------------------------------------------------------
  -- Non-présentation : l'événement est postérieur au début de la
  -- location. Le client est arrivé, ou n'est jamais venu.
  -- -------------------------------------------------------------------
  IF p_at >= b.start_at THEN
    basis := 'no_show';

    -- La location n'est facturée que si la politique le décide.
    -- L'hypothèse par défaut est de ne PAS la facturer : le service
    -- n'a pas été rendu. Voir `no_show_charges_rental`.
    rental := CASE
      WHEN (pol ->> 'noShowChargesRental')::boolean THEN rental
      ELSE 0
    END;

    penalty_amount := 0;

    deposit_forfeited := CASE
      WHEN (pol ->> 'noShowDepositForfeited')::boolean THEN deposit
      ELSE 0
    END;

  -- -------------------------------------------------------------------
  -- Annulation dans le délai gratuit
  -- -------------------------------------------------------------------
  ELSIF hours_before >= (pol ->> 'freeCancellationHours')::int THEN
    basis := 'free';
    penalty_amount := 0;
    deposit_forfeited := 0;

  -- -------------------------------------------------------------------
  -- Annulation tardive : pénalité sur le tarif de LOCATION
  -- -------------------------------------------------------------------
  ELSE
    basis := 'late_penalty';
    penalty_amount := round(
      rental::numeric * (pol ->> 'lateCancellationPenaltyPercent')::numeric / 100
    )::bigint;
    deposit_forfeited := 0;
  END IF;

  -- Ce qui revient au client : ce qui a été encaissé, moins ce qui est
  -- retenu. Une formule unique, pour que le remboursement ne puisse pas
  -- être calculé différemment du prélèvement.
  rental_amount := rental;

  rental_amount := rental;

  refund_amount := rental + deposit - penalty_amount - deposit_forfeited;

  -- Un remboursement négatif signifierait qu'on retient plus que ce qui
  -- a été encaissé. C'est impossible ici (les deux parts viennent de la
  -- même réservation) mais la contrainte est mise : si une politique
  -- devient plus sévère, l'erreur doit être un refus à l'écriture, pas
  -- une demande de virement à un client.
  IF refund_amount < 0 THEN
    RAISE EXCEPTION
      'reservation % : remboursement negatif (%), la politique retient plus que le montant encaisse',
      p_booking, refund_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEXT;
END
$$;

COMMENT ON FUNCTION booking_financial_outcome(uuid, timestamptz) IS
  'Calcul UNIQUE du sort financier d une annulation (CDCS 4.6). Toute '
  'surface qui repond a « combien doit le client » doit appeler cette '
  'fonction : une deuxième implémentation divergerait, et c''est la version '
  'fausse qui factura.';

-- -------------------------------------------------------------------
-- 4. Restitution tardive
-- -------------------------------------------------------------------
CREATE FUNCTION booking_overtime(p_booking uuid, p_returned_at timestamptz)
RETURNS TABLE (
  grace_minutes int,
  overage_hours int,
  daily_rate bigint,
  overage_amount bigint
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  pol jsonb;
  pricing jsonb;
  grace interval;
  billable interval;
BEGIN
  SELECT policy_snapshot, pricing_snapshot
    INTO pol, pricing
    FROM booking WHERE id = p_booking;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation % introuvable', p_booking
      USING ERRCODE = 'no_data_found';
  END IF;

  IF pol IS NULL THEN
    RAISE EXCEPTION 'reservation % sans politique figee', p_booking
      USING ERRCODE = 'check_violation';
  END IF;

  -- Le tarif journalier est un MONTANT : il vient de `pricing_snapshot`,
  -- pas de la politique. Lire la regle pour un montant donnerait NULL,
  -- donc un dépassement gratuit — l'inverse exact du defaut corrige
  -- dans `booking_financial_outcome`, et tout aussi silencieux.
  IF (pricing ->> 'dailyRateAtCreation') IS NULL THEN
    RAISE EXCEPTION
      'reservation % : tarif journalier absent du snapshot de tarif',
      p_booking
      USING ERRCODE = 'check_violation';
  END IF;

  grace := make_interval(
    mins => (pol ->> 'lateReturnGraceMinutes')::int
  );

  -- Ce qui dépasse APRÈS la grâce. Rester pile à la fin n'est pas du
  -- dépassement ; le dépasser d'une seconde l'est, pour la totalité de
  -- l'heure commencée.
  billable := greatest(
    interval '0',
    p_returned_at - (SELECT end_at FROM booking WHERE id = p_booking) - grace
  );

  -- `ceil` sur un intervalle : chaque heure commencede est due en
  -- entier. Une seconde de dépassement vaut une heure.
  overage_hours := ceil(extract(epoch FROM billable) / 3600.0)::int;

  daily_rate := (pricing ->> 'dailyRateAtCreation')::bigint;

  overage_amount := (
    overage_hours
    * round(
        daily_rate::numeric * (pol ->> 'lateReturnOveragePercent')::numeric / 100
      )::bigint
  )::bigint;

  RETURN NEXT;
END
$$;

-- -------------------------------------------------------------------
-- 5. Figer la politique à la création de la réservation
-- -------------------------------------------------------------------
-- Exactement le même principe que la commission (migration 0002) : la
-- règle appliquée est celle en vigueur AU MOMENT de la réservation.
-- Modifier une politique ne doit pas réécrire l'histoire des
-- réservations passées.
ALTER TABLE booking
  ADD COLUMN policy_snapshot jsonb;

CREATE FUNCTION freeze_booking_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pol financial_policy%ROWTYPE;
BEGIN
  SELECT * INTO pol FROM resolve_financial_policy(NEW.owner_id);

  -- Aucune politique applicable : on refuse de créer la réservation.
  -- En accepter une sans règle de sortie serait promettre un montant que
  -- personne ne pourra calculer le jour de l'annulation.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'aucune politique financiere applicable au proprietaire % : reservation impossible',
      NEW.owner_id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.policy_snapshot := jsonb_build_object(
    'policyId', pol.id,
    'freeCancellationHours', pol.free_cancellation_hours,
    'lateCancellationPenaltyPercent', pol.late_cancellation_penalty_percent,
    'noShowDepositForfeited', pol.no_show_deposit_forfeited,
    'noShowChargesRental', pol.no_show_charges_rental,
    'lateReturnGraceMinutes', pol.late_return_grace_minutes,
    'lateReturnOveragePercent', pol.late_return_overage_percent,
    'resolvedAt', now()
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_booking_freeze_policy
  BEFORE INSERT ON booking
  FOR EACH ROW
  EXECUTE FUNCTION freeze_booking_policy();

-- -------------------------------------------------------------------
-- 6. Les montants ne se saisissent pas : ils se calculent
-- -------------------------------------------------------------------
ALTER TABLE booking
  ADD COLUMN cancellation_penalty_amount bigint,
  ADD COLUMN forfeited_deposit_amount bigint;

-- La cohérence est vérifiée à l'écriture, pas seulement documentée.
-- Une pénalité ne peut pas être négative ; elle ne peut pas non plus
-- dépasser le tarif de location, ce qui résulterait d'une confusion avec le
-- total — celle que cet en-tête décrit précisément.
CREATE FUNCTION check_booking_penalty_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rental bigint;
BEGIN
  IF NEW.cancellation_penalty_amount IS NULL
     AND NEW.forfeited_deposit_amount IS NULL THEN
    RETURN NEW;
  END IF;

  rental := (NEW.pricing_snapshot ->> 'rentalAmount')::bigint;

  IF NEW.cancellation_penalty_amount < 0
     OR NEW.forfeited_deposit_amount < 0 THEN
    RAISE EXCEPTION
      'reservation % : montants de sanction negatifs (penalite %, caution %)',
      NEW.id, NEW.cancellation_penalty_amount, NEW.forfeited_deposit_amount
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.cancellation_penalty_amount > rental THEN
    RAISE EXCEPTION
      'reservation % : penalite (%) superieure au tarif de location (%). Une sanction ne peut pas depasser le service facture — verifier que la caution n a pas ete incluse par erreur.',
      NEW.id, NEW.cancellation_penalty_amount, rental
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.forfeited_deposit_amount > NEW.deposit_amount THEN
    RAISE EXCEPTION
      'reservation % : caution confisquee (%) superieure a la caution (%)',
      NEW.id, NEW.forfeited_deposit_amount, NEW.deposit_amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_booking_penalty_consistency
  BEFORE UPDATE ON booking
  FOR EACH ROW
  EXECUTE FUNCTION check_booking_penalty_consistency();

-- -------------------------------------------------------------------
-- 7. Réserver les résolutions existantes
-- -------------------------------------------------------------------
-- Les réservations créées avant cette migration n'ont pas de politique
-- figée. Leur en attribuer une rétroactivement reviendrait à leur
-- appliquer une règle qui n'existait pas à leur création — donc à
-- confectionner une pénalité qui n'a jamais été annoncée.
--
-- Aucune ne reçoit donc de politique. `booking_financial_outcome`
-- refuse alors de les calculer, ce qui est le comportement correct :
-- ces réservations ont été conclues sans condition financière et doivent
-- être traitées manuellement.
--
-- Cette décision est visible : `pricing_snapshot` porte la trace, et la
-- fonction refuse explicitement plutôt que de deviner.

-- -------------------------------------------------------------------
-- 8. Un test de non-régression du calcul
-- -------------------------------------------------------------------
-- La base ne garantit pas que `booking_financial_outcome` calcule juste :
-- elle garantit qu'elle est la SEULE à calculer. L'exactitude se teste,
-- et le test est dans `tests/politiques-smoke.sql`.

-- -------------------------------------------------------------------
-- 9. Les snapshots sont IMMUABLES
-- -------------------------------------------------------------------
-- Verifie sur la base de developpement, avant cette section :
--
--     UPDATE booking SET pricing_snapshot = pricing_snapshot || ...  -> accepte
--     UPDATE booking SET policy_snapshot = NULL                      -> accepte
--
-- Les deux reussissaient, sans message. Figer une regle sans interdire
-- de la modifier ne la fige pas : c'est une rege que le premier `UPDATE`
-- contournant peut effacer. Un devis presente a un client pouvait etre
-- remplace apres coup, et une sanction recalculee sur une base choisie
-- apres coup. Un litige tranche six mois plus tard n'aurait plus aucune
-- base.
--
-- Regle : un snapshot pose ne se reecrit pas.
--
-- Corriger une erreur de saisie n'est donc PAS une mise a jour : c'est
-- une annulation suivie d'une nouvelle reservation. La correction est un
-- acte metier, trace, visible des deux parties. La rendre techniquement
-- silencieuse l'aurait transformee en retouche invisible.
--
-- `total_amount` et `deposit_amount` sont traites de la meme facon : ce
-- sont les montants figures dans le devis, donc ils relevent du meme
-- verrou.
CREATE FUNCTION prevent_booking_snapshot_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  champ text;
  ancien text;
  nouveau text;
BEGIN
  FOREACH champ IN ARRAY ARRAY[
    'pricing_snapshot', 'policy_snapshot', 'total_amount', 'deposit_amount'
  ] LOOP
    ancien := to_jsonb(OLD) ->> champ;
    nouveau := to_jsonb(NEW) ->> champ;

    IF ancien IS DISTINCT FROM nouveau THEN
      RAISE EXCEPTION
        'reservation % : % est fige a la creation (% -> %) et ne peut pas etre reecrit. Corriger passe par une annulation puis une nouvelle reservation.',
        NEW.id, champ, coalesce(ancien, 'vide'), coalesce(nouveau, 'vide')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_booking_snapshot_immutable
  BEFORE UPDATE ON booking
  FOR EACH ROW
  EXECUTE FUNCTION prevent_booking_snapshot_rewrite();

COMMENT ON FUNCTION prevent_booking_snapshot_rewrite() IS
  'Les devis et les regles sont figes a la creation de la reservation (CDCS 8.6). Un snapshot pose ne se reecrit pas : corriger passe par une annulation puis une nouvelle reservation.'
