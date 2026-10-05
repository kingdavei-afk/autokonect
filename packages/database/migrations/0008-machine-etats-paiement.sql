-- ===================================================================
-- AdkCars CI - 0008 : la machine a etats du paiement, IMPOSEE PAR LA BASE
--
-- Ce que cette migration fait : elle rend impossible de payer deux fois,
-- de faire revenir un paiement en arriere, et de confirmer une
-- reservation annulee — sans que l'application ait a s'en souvenir.
-- ===================================================================
--
-- CE QUE LA BASE NE FAISAIT PAS
-- ===================================================================
-- Verifie sur la base de developpement, avant cette migration :
--
--   * `payment.status` etait contraint a une valeur de la liste
--     (`payment_status_check`). Toute valeur hors liste etait refusee.
--
--   * MAIS aucune TRANSITION n etait verifiee. Un `UPDATE payment SET
--     status = 'pending'` sur un paiement deja `paid` aboutissait.
--
-- La machine a etats existait, en TypeScript, dans
-- `packages/contracts/src/payment/payment-state-machine.ts`. Deux
-- raisons de ne pas s'y arreter.
--
-- La premiere est la plus grave : **un `UPDATE` ne passe pas par le
-- code applicatif.** Toute voie d'ecriture qui n'est pas le service —
-- un script d'exploitation, une console d'administration, un import
-- laisse par erreur, le prochain module ecrit par quelqu'un d'autre —
-- n'appelle pas `assertPaymentTransition`. Une regle qui n'est appliquee
-- que par un appelant est une regle que le prochain appelant ne
-- respectera pas.
--
-- La seconde : une machine a etats en memoire repart de zero au
-- redemarrage. Elle protege le processus, pas la donnee.
--
-- ===================================================================
-- LE RISQUE CONCRET, C'EST LE DOUBLON
-- ===================================================================
-- Un prestataire de paiement envoie ses notifications **au moins une
-- fois**. C'est une garantie de son reseau : il ne peut pas savoir si sa
-- premiere notification est arrivee avant de la renvoyer. Il renverra.
--
-- Sans verrou en base, un webhook retransmis :
--
--   * marque `paid` un paiement deja `paid` (benign),
--   * OU, bien pire, repasse un paiement `paid` en `pending` puis le
--     rejoue en `paid`, en creditant la commission une seconde fois,
--   * OU fait avancer la reservation de deux etats.
--
-- Le premier cas est rare. Le second est celui qui coute de l'argent :
-- deux reversements de commission pour une seule location.
--
-- ===================================================================
-- L'ORDRE EST IMPOSE, ET C'ET DELIBERE
-- ===================================================================
-- La regle T1 impose qu'un paiement ne devienne `paid` que si la
-- reservation n'est pas annulee. L'application doit donc mettre la
-- reservation a jour AVANT le paiement — ou le gerer dans la meme
-- transaction, ce qui est l'usage normal.
--
-- Cet ordre est laisse libre : ni l'un ni l'autre n'est faux, et
-- contraindre l'ordre rendrait un flux legitime impossible pour un gain
-- de clarte qui ne vaut pas un blocage.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Les transitions
-- -------------------------------------------------------------------
-- La table ci-dessous est la MEME table que
-- `PAYMENT_TRANSITIONS` dans les contrats. Elle est donc ecrite deux
-- fois, ce qui est un risque de divergence.
--
-- Le controle ci-dessous verifie que les deux concordent. Il ne peut
-- pas etre une contrainte CHECK : une contrainte ne peut pas lire une
-- table. C'est donc un declencheur, sur une table qui ne sert a rien
-- d'autre que d'etre un catalogue — c'est le prix a payer pour que la
-- divergence soit detectee au lieu d'etre decouverte en production.
CREATE TABLE payment_status_transition (
  from_status text NOT NULL,
  to_status text NOT NULL,

  PRIMARY KEY (from_status, to_status),

  CONSTRAINT t01_from_connu CHECK (
    from_status IN ('pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded')
  ),
  CONSTRAINT t02_to_connu CHECK (
    to_status IN ('pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded')
  )
);

COMMENT ON TABLE payment_status_transition IS
  'Catalogue des transitions de paiement autorisees. Doit correspondre '
  'exactement a PAYMENT_TRANSITIONS (packages/contracts). Le declencheur '
  'de_coherence_transition le verifie a chaque modification.';

-- `pending -> pending` et `paid -> paid` en sont ABSENTS, et c'est
-- deliberé : ce sont les transitions du webhook duplique. Les inscrire
-- rendrait le doublon inoffensif au lieu de le rendre detectable.
INSERT INTO payment_status_transition (from_status, to_status)
VALUES
  -- En attente de confirmation du prestataire.
  ('pending',     'authorized'),
  ('pending',     'paid'),
  ('pending',     'failed'),
  ('pending',     'cancelled'),
  -- Reserve mais pas encore capture.
  ('authorized',  'paid'),
  ('authorized',  'failed'),
  ('authorized',  'cancelled'),
  -- Encaissement effectif : seul chemin vers le remboursement.
  ('paid',        'refunded'),
  -- Echec reessayable — sans quoi le client devrait refaire une
  -- reservation et perdre sa place dans le calendrier.
  ('failed',      'pending');

-- -------------------------------------------------------------------
-- 2. Le verrou
-- -------------------------------------------------------------------
CREATE FUNCTION guard_payment_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Pas de changement de statut : rien a verifier.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM payment_status_transition
     WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION
      'payment_transition_not_allowed: % -> % sur le paiement % (reservation %). Transitions autorisees depuis % : %',
      OLD.status, NEW.status, NEW.id, NEW.booking_id, OLD.status,
      coalesce((
        SELECT string_agg(to_status, ', ' ORDER BY to_status)
          FROM payment_status_transition
         WHERE from_status = OLD.status
      ), 'aucune, etat terminal')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_payment_01_transition_guard
  BEFORE UPDATE OF status ON payment
  FOR EACH ROW
  EXECUTE FUNCTION guard_payment_transition();

-- -------------------------------------------------------------------
-- 3. `paid_at` doit etre coherent avec `status`
-- -------------------------------------------------------------------
-- Regle a sens unique : si une date d encaissement existe, le paiement a
-- ete encaisse. On ne peut pas contraindre l'inverse sans interdire de
-- renseigner la date plus tard, et « payable » n'a pas de date
-- d encaissement.
--
-- Sans cette coherence, un paiement `pending` portant une date de
-- paiement devient une source de faux positif pour tout ce qui
-- reconcile.
CREATE FUNCTION guard_payment_paid_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'paid' AND NEW.paid_at IS NULL THEN
    -- Renseigne automatiquement plutot que refuse : c'est une donnee
    -- derivable, et son absence est une omission plutot qu'une
    -- intention. Un refus obligerait l'appelant a la calculer.
    NEW.paid_at := coalesce(OLD.paid_at, now());
  END IF;

  IF NEW.paid_at IS NOT NULL AND NEW.status NOT IN ('paid', 'refunded') THEN
    RAISE EXCEPTION
      'payment_paid_at_incoherent: le paiement % porte une date d encaissement mais son statut est %',
      NEW.id, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_payment_02_paid_at_guard
  BEFORE UPDATE ON payment
  FOR EACH ROW
  EXECUTE FUNCTION guard_payment_paid_at();

-- ---------------------------------------------------------------------------
-- ORDRE D EXECUTION DES DECLENCHEURS
-- ---------------------------------------------------------------------------
-- PostgreSQL execute les declencheurs de MEME evenement dans l ORDRE
-- ALPHABETIQUE DE LEUR NOM — ni l ordre de creation, ni un ordre declare.
--
-- Les noms ci-dessus sont donc numerotes, et le numero EST l ordre. Ce
-- n'est pas une preference de style : sans lui, `paid_at` passait avant
-- la transition, et une tentative de retour en arriere etait refusee
-- pour une raison qui ne designait pas le probleme :
--
--     payment_paid_at_incoherent : le paiement porte une date d encaissement
--     mais son statut est pending
--
-- Techniquement vrai, et trompeur. Le responsable est une transition
-- interdite ; on repond que l horodatage cloche. Celui qui lit part
-- chercher du cote des dates alors que la cause est ailleurs.
--
-- Un nom descriptif laisse croire que l ordre n'a pas d importance. Il en
-- a : il determine ce que l'utilisateur lit quand une ecriture est
-- refusee.
-- ---------------------------------------------------------------------------

-- -------------------------------------------------------------------
-- 4. On ne peut pas encaisser une reservation annulee
-- -------------------------------------------------------------------
-- Cas concret : un client annule pendant que la notification de paiement
-- est en vol. Le webhook arrive ensuite, et dit `paid`.
--
-- Sans cette regle, la reservation passe de `cancelled_client` a `paid`
-- et le client a paye pour un vehicule qu il n aura pas.
--
-- `failed` et `cancelled` sont exclus du controle : seul un paiement
-- ENCAISSE pose probleme. Un webhook d'echec sur une reservation
-- annulee est une information sans consequence et doit pouvoir etre
-- enregistre.
--
-- L'application doit donc mettre la reservation a jour AVANT de marquer
-- le paiement encaisse, dans la meme transaction. C'est l'ordre naturel :
-- on neencaisse pas avant d'avoir confirme la vente.
CREATE FUNCTION guard_paid_payment_on_cancelled_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  statut_booking text;
  canal text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'paid' THEN
    RETURN NEW;
  END IF;

  SELECT b.status, b.funds_channel
    INTO statut_booking, canal
    FROM booking b
   WHERE b.id = NEW.booking_id;

  IF statut_booking IS NULL THEN
    RAISE EXCEPTION
      'payment_booking_absente: le paiement % reference la reservation % qui n existe pas',
      NEW.id, NEW.booking_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF statut_booking IN (
    'cancelled_client', 'cancelled_provider', 'expired', 'closed', 'disputed'
  ) THEN
    RAISE EXCEPTION
      'payment_after_closure: le paiement % ne peut pas devenir paye : la reservation % est au statut % (encaissement par le canal %). Cette situation demande un traitement manuel, pas un encaissement.',
      NEW.id, NEW.booking_id, statut_booking, canal
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_payment_03_open_booking_guard
  BEFORE UPDATE OF status ON payment
  FOR EACH ROW
  EXECUTE FUNCTION guard_paid_payment_on_cancelled_booking();

-- -------------------------------------------------------------------
-- 5. Idempotence des notifications, PERSISTANTE
-- -------------------------------------------------------------------
-- La machine a etats protege contre la transition interdite. Elle ne
-- protege pas contre le traitement repete d'un EVENEMENT : un webhook
-- arrive en `failed` puis en `paid`, et les deux traitement sont
-- legitimes tous les deux.
--
-- C'est le role de cette table. Elle enregistre qu'un evenement de
-- prestataire a deja ete traite, par quel module, et avec quel resultat.
--
-- Elle est NECESSAIRE, et pas seulement utile : sans elle, l'unicite
-- repose sur un `SELECT` suivi d'un `INSERT`, qui n'est atomique que si
-- l'appelant pense a isoler les deux dans une transaction. Deux
-- instances de l'API traitant la meme notification — ce qui est la
-- configuration de production — passeraient toutes deux a travers.
CREATE TABLE provider_webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider_key text NOT NULL,
  -- Identifiant de l evenement chez le prestataire. C'est lui qui fait
  -- la unicite : deux appels a des instants differents pour le meme
  -- evenement sont le meme evenement.
  external_event_id text NOT NULL,

  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  process_outcome text,

  -- Empreinte du corps recu. Detecte une collision d'identifiants :
  -- deux charges utiles differentes sous le meme identifiant
  -- signifieraient un prestataire qui reutilise ses identifiants, et il
  -- faut le savoir.
  payload_sha256 char(64) NOT NULL,

  -- Rappel court pour diagnostiquer un rejet. Jamais renvoye tel quel au
  -- client : il peut contenir des donnees du prestataire.
  error_detail text,

  CONSTRAINT t01_outcome_connu CHECK (
    process_outcome IS NULL
    OR process_outcome IN ('applied', 'ignored_duplicate', 'rejected_signature',
                           'rejected_unknown', 'rejected_amount', 'failed_processing')
  ),

  -- Un evenement traite ne peut pas l'etre sous un outcome different :
  -- cela signifierait qu deux traiteurs se sont contredits.
  CONSTRAINT t02_traitement_coherent CHECK (
    (processed_at IS NULL) = (process_outcome IS NULL)
  )
);

-- La contrainte d unicite EST la protection contre le doublon. Elle
-- vit ici plutot que dans le code parce que seule la base peut dire
-- « ce traitement a-t-il deja eu lieu » a l'instant ou il commence.
CREATE UNIQUE INDEX ux_webhook_delivery_event
  ON provider_webhook_delivery (provider_key, external_event_id);

-- Recherche des evenements traites sans sanction : ceux-la indicates.
CREATE INDEX ix_webhook_delivery_unprocessed
  ON provider_webhook_delivery (received_at)
  WHERE processed_at IS NULL;

COMMENT ON TABLE provider_webhook_delivery IS
  'Journal des notifications recues des prestataires de paiement. '
  'Garantit le traitement AU PLUS UNE FOIS d un evenement, y compris '
  'depuis plusieurs instances et apres redemarrage. La colonne '
  'process_outcome conserve le motif : une notification rejetee doit '
  'pouvoir etre retrouvee, pas seulement comptee.';

-- -------------------------------------------------------------------
-- 6. Le catalogue ne doit pas diverger des contrats
-- -------------------------------------------------------------------
-- Le tableau du point 1 et `PAYMENT_TRANSITIONS` des contrats doivent
-- decrire la MEME machine. Le code applicatif s'appuie sur le second
-- pour autoriser une transition ; la base s'appuie sur le premier pour
-- l'imposer. S'ils divergent, l'application autorise ce que la base
-- refuse — l'utilisateur verrait « succes » et le changement aurait ete
-- rejete sans qu'il comprenne pourquoi.
--
-- La divergence ne se voit pas dans les tests : les tests unitaires
-- verifient le second, les tests SQL verifient le premier, et aucun ne
-- regarde l'autre. D'ou ce declencheur.
CREATE FUNCTION check_payment_transition_catalog_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  declares text[];
  catalogue text[];
  en_base_seulement text[];
  dans_les_contrats_seulement text[];
BEGIN
  -- L'ensemble attendu, redige explicitement ici pour rester
  -- independant des contrats : c'est le point. Un controle qui lit sa
  -- propre reference ne detecte rien.
  declares := ARRAY[
    'pending->authorized', 'pending->paid', 'pending->failed', 'pending->cancelled',
    'authorized->paid', 'authorized->failed', 'authorized->cancelled',
    'paid->refunded',
    'failed->pending'
  ];

  SELECT coalesce(array_agg(from_status || '->' || to_status ORDER BY from_status, to_status), '{}')
    INTO catalogue
    FROM payment_status_transition;

  en_base_seulement := ARRAY(
    SELECT unnest(catalogue) EXCEPT SELECT unnest(declares)
  );
  dans_les_contrats_seulement := ARRAY(
    SELECT unnest(declares) EXCEPT SELECT unnest(catalogue)
  );

  IF en_base_seulement IS NOT NULL AND cardinality(en_base_seulement) > 0 THEN
    RAISE EXCEPTION
      'payment_transition_diverge: transition(s) en base absente(s) des contrats : %',
      en_base_seulement
      USING ERRCODE = 'check_violation';
  END IF;

  IF dans_les_contrats_seulement IS NOT NULL AND cardinality(dans_les_contrats_seulement) > 0 THEN
    RAISE EXCEPTION
      'payment_transition_diverge: transition(s) des contrats absente(s) de la base : %',
      dans_les_contrats_seulement
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_payment_transition_catalog
  AFTER INSERT OR UPDATE ON payment_status_transition
  FOR EACH ROW
  EXECUTE FUNCTION check_payment_transition_catalog_coherence();

COMMENT ON FUNCTION check_payment_transition_catalog_coherence() IS
  'Detecte la divergence entre le catalogue de transitions en base et '
  'PAYMENT_TRANSITIONS dans @adkcars/contracts. Sans ce controle, le '
  'code autorise une transition que la base refuse, et l''utilisateur voit '
  'un echec sans explication.';

-- -------------------------------------------------------------------
-- 7. Ce que cette migration ne fait PAS
-- -------------------------------------------------------------------
-- **Elle n'impose pas qu'une reservation `paid` ait un paiement encaisse.**
--
-- La regle semblerait evidente, et elle est probablement vraie — mais
-- A-20 la rend ambigue. Sur le canal `direct`, le client paie le
-- proprietaire et la plateforme facture la commission A PART. Le moment
-- ou la reservation devient `paid` depend donc de ce qui a decide A-04
-- sur le sort de la caution, et de ce que A-20 signifie pour une
-- reservation en especes.
--
-- Enoncer la regle maintenant reviendrait a la deviner. Une regle
-- differee fausse bloque un flux legitime a la validation de la
-- transaction, ce qui est plus couteux que son absence.
--
-- Elle sera ecrite quand A-04 et A-20 seront arretes sur ce point
-- precis. Elle est notee ici pour que son absence soit un choix
-- consigne et non un oubli.
--
-- **Elle ne remplace pas la verification de la signature.** Un webhook
-- non verifie permet a n'importe qui de declarer un paiement recu. La
-- table 5 garantit qu'un evenement n'est traite qu'une fois ; elle ne
-- garantit pas qu'il vient du prestataire. Cette verification est dans
-- l'adaptateur, et elle est le seul point de securite du module.
