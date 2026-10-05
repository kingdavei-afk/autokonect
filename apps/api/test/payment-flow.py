# -*- coding: utf-8 -*-
"""Parcours de bout en bout du paiement.

Verifie le chemin COMPLET : ouverture d'intention, notification signee,
confirmation de la reservation, et refus de ce qui doit l'etre.

Il passe par l'API HTTP de bout en bout, pas par le service : le module
fait vivant des choix qu'un test de service ne verrait pas — le corps
brut du webhook, l'absence d'authentification sur la route, la
signature calculee sur les octets recus.
"""
import io, json, os, re, subprocess, sys, time, urllib.error, urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

API = "http://127.0.0.1:3000"
API_LOG = r"E:\ADKauto\apps\api\api.err.log"
PSQL = r"E:\ADKauto\.tools\pgsql\pgsql\bin\psql.exe"

reussis = 0
echecs = 0


def dire(texte):
    print(texte)


def verifier(libelle, condition, detail=""):
    global reussis, echecs
    if condition:
        reussis += 1
        dire(f"  OK   {libelle}")
    else:
        echecs += 1
        dire(f"  ECHEC {libelle}" + (f" — {detail}" if detail else ""))


def sql(requete):
    """
    Execute une requete et renvoie SA SORTIE.

    En cas d echec, PostgreSQL ecrit sur `stderr` et laisse `stdout` vide.
    L'erreur est donc REMONTEE : un test qui verifie qu'une ecriture est
    refusee doit avoir acces au refus, sinon il ne verifie rien.

    Sans cela, ce helper renvoyait une chaine vide pour un refus, et le
    test concluait que l'operation avait abouti — l'inverse de la
    realite. C'est le pire defaut qu'un test puisse avoir : il accuse le
    produit d'un defaut inexistant et envoie chercher au mauvais endroit.
    """
    env = dict(os.environ)
    env["PGPASSWORD"] = "adkcars_dev"

    # `ON_ERROR_STOP` : psql sort des la premiere erreur au lieu de
    # poursuivre. Sans lui, une instruction refusee en debut de chaine
    # laisse executer la suite, et le resultat melange plusieurs requetes.
    p = subprocess.run(
        [PSQL, "-U", "postgres", "-h", "127.0.0.1", "-d", "adkcars_dev",
         "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input=requete, capture_output=True, text=True, encoding="utf-8",
        errors="replace", env=env,
    )

    if p.returncode != 0:
        # La sortie d'erreur EST le resultat attendu de la requete.
        return (p.stderr or "ERREUR SQL").strip()

    return (p.stdout or "").strip()


def appeler(method, chemin, corps=None, jeton=None, signature=None, brut=None):
    """Appel HTTP. `brut` permet d'envoyer des octets non re-serialises."""
    url = API + chemin
    donnees = None

    if brut is not None:
        donnees = brut if isinstance(brut, bytes) else brut.encode("utf-8")
    elif corps is not None:
        donnees = json.dumps(corps).encode("utf-8")

    requete = urllib.request.Request(url, data=donnees, method=method)
    requete.add_header("accept", "application/json")

    if donnees is not None:
        requete.add_header("content-type", "application/json")
    if jeton:
        requete.add_header("authorization", "Bearer " + jeton)
    if signature:
        requete.add_header("x-adkcars-signature", signature)

    try:
        with urllib.request.urlopen(requete, timeout=25) as reponse:
            texte = reponse.read().decode()
            return reponse.status, (json.loads(texte) if texte else {})
    except urllib.error.HTTPError as e:
        texte = e.read().decode()
        try:
            return e.code, json.loads(texte or "{}")
        except json.JSONDecodeError:
            return e.code, {"message": texte[:300]}


def dernier_code(telephone):
    """
    Lit le code OTP dans le journal du fournisseur simule.

    Le journal masque le telephone (`**********3351`) : filtrer par numero
    complet ne trouve donc rien. On prend la derniere ligne « SMS simule »,
    ce qui est le code de l inscription en cours puisque le journal est
    ecrit avant que l inscription ne reponde.

    `position` est le numero de lignes deja consommees : sans lui, deux
    comptes crees d affilee leiraient le meme code, et le second verifierait
    le telephone du premier.
    """
    global dernier_code_position

    for _ in range(40):
        try:
            with io.open(API_LOG, encoding="utf-8", errors="replace") as f:
                lignes = f.readlines()
        except OSError:
            lignes = []

        codes = []
        for ligne in lignes:
            if "SMS simule" not in ligne:
                continue
            m = re.search(r"est (\d{6})", ligne)
            if m:
                codes.append(m.group(1))

        if len(codes) > dernier_code_position:
            dernier_code_position += 1
            return codes[-1]

        time.sleep(0.4)

    return None


# Nombre de codes deja lus. Sans ce compteur, deux inscriptions
# successives partageraient le meme code.
dernier_code_position = 0


def compte(tag, prefixe, role="client"):
    suffixe = str(int(time.time()))[-6:]
    telephone = "+225%s%s" % (prefixe, suffixe)
    courriel = "%s.%s@adkcars.ci" % (tag, suffixe)
    mot_de_passe = "MotDePasseSolide2026"

    st, corps = appeler("POST", "/auth/register", {
        "email": courriel, "phone": telephone, "password": mot_de_passe,
        "role": role, "acceptTerms": True,
    })
    assert st == 201, f"inscription {tag} : {st} {corps.get('message')}"

    code = dernier_code(telephone)
    assert code, f"{tag} : code OTP introuvable"

    st, corps = appeler("POST", "/auth/verify-phone", {"phone": telephone, "code": code})
    assert st == 200, f"verification {tag} : {st} {corps.get('message')}"

    st, corps = appeler("POST", "/auth/login", {"identifier": telephone, "password": mot_de_passe})
    assert st == 200, f"connexion {tag} : {st}"

    return {"phone": telephone, "token": corps["accessToken"], "password": mot_de_passe}


# La cle de signature doit etre celle du serveur : le webhook signe avec
# elle, et une autre ne verifierait pas.
SECRET = os.environ.get("PAYMENT_PROVIDER_SECRET") or sql(
    "SELECT '' FROM (SELECT 1) x WHERE false;"
)
if not SECRET:
    # Relue depuis la configuration du processus : le serveur la tient en
    # memoire, on ne peut pas la lire en base. On la lit donc dans le
    # fichier d environnement, comme le serveur.
    try:
        env_txt = io.open(r"E:\ADKauto\.env", encoding="utf-8").read()
        m = re.search(r"^PAYMENT_PROVIDER_SECRET=(.+)$", env_txt, re.M)
        if m:
            SECRET = m.group(1).strip().strip('"').strip("'")
    except OSError:
        pass


import hashlib
import hmac


def signer(charge):
    return hmac.new(SECRET.encode("utf-8"), charge.encode("utf-8"), hashlib.sha256).hexdigest()


def commission_du_proprietaire():
    """
    Commission portee par le proprietaire de flottes de ce test.

    `provider_ledger` est un agregat PAR PARTENAIRE : une ligne par
    (type, identifiant, nom). Il n'a pas de `booking_id`, et cette colonne
    n'existe pas. Compter des lignes serait compter des partenaires, pas
    des commissions.
    """
    total = sql(
        "SELECT coalesce(sum(commission_taken), 0) FROM provider_ledger;"
    )
    return total or "0"


def notification(reference_externe, statut, montant="180000", identifiant=None):
    """Charge utile de notification, comme en emettrait un prestataire."""
    return json.dumps({
        "event_id": identifiant or f"{reference_externe}-{statut}",
        "external_ref": reference_externe,
        "status": statut,
        "amount": montant,
        "currency": "XOF",
        "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })


# Plaque propre a chaque execution.
#
# L unicite de l immatriculation est VERIFIEE PAR LA BASE. Un test qui
# reutilise une plaque fixe echoue des la deuxieme execution, avec un
# message qui ne parle que de validation — alors que le produit
# fonctionne. C est le pire des echecs de test : il accuse le code
# d un defaut qu il n a pas.
PLAQUE = "PLAQ" + str(int(time.time()))[-6:]

# Suffixe des identifiants d EVENEMENT.
#
# Un identifiant d evenement designe UN evenement precis. Le donner en
# dur rendait le second lancement indistinguable du premier : le journal
# le reconnaisait comme un doublon, et le test concluait que le produit
# ignorait un paiement — alors que c etait le test qui reutilisait
# l'identite d un evenement deja consomme.
#
# Meme nature que la plaque en dur : une donnee qui doit etre unique,
# rendue constante.
SUFFIXE = str(int(time.time()))[-6:]


def main():
    dire("")
    dire("=== preparation ===")

    if len(SECRET) < 32:
        dire(f"  ECHEC configuration : PAYMENT_PROVIDER_SECRET absente ou trop courte ({len(SECRET)} caracteres)")
        dire("")
        dire("RESULTAT : 0 reussis, 1 echec sur 1")
        return 1

    client = compte("payclient", "0730")
    proprietaire = compte("payflotte", "0731", "owner")
    dire(f"  client {client['phone']} · proprietaire {proprietaire['phone']}")

    # La categorie est un referentiel d exploitant, donc volontairement
    # ABSENTE d une migration (voir le commentaire de la migration 0006).
    # Une base neuve n'en a pas, et le test echouait alors sur un
    # `400 Donnees invalides.` qui ne nommait aucun champ.
    #
    # Le test cree donc ce dont il a besoin. C est de la donnee de TEST :
    # aucun autre test n'en suppose l existence, donc aucun n'en depend.
    sql(
        "INSERT INTO vehicle_category (slug, label) VALUES ('berline', 'Berline') "
        "ON CONFLICT (slug) DO NOTHING;"
    )

    id_berline = sql("SELECT id FROM vehicle_category WHERE slug='berline';")

    if not id_berline:
        dire("  ECHEC : categorie de vehicule introuvable apres creation")
        return 1

    # Le prix de location est 60 000 / jour ; la caution 500 000.
    st, v = appeler("POST", "/vehicles", {
        "categoryId": id_berline, "brand": "Peugeot", "model": "301", "year": 2023,
        "plateNumber": PLAQUE, "transmission": "manual", "fuel": "petrol",
        "seats": 5, "dailyRate": "60000", "depositAmount": "500000",
        "withDriver": False,
    }, jeton=proprietaire["token"])
    assert st == 201, f"vehicule : {st} {v.get('message')}"

    vehicule = v["id"]
    sql(f"UPDATE vehicle SET status='published' WHERE id='{vehicule}';")

    base = time.time() + 40 * 86_400
    debut = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base))
    fin = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base + 3 * 86_400))

    st, r = appeler("POST", "/bookings", {
        "vehicleId": vehicule, "startAt": debut, "endAt": fin, "isOneWay": False,
    }, jeton=client["token"])
    assert st == 201, f"reservation : {st} {r.get('message')}"
    reservation = r["id"]
    dire(f"  reservation {r['reference']} — location {r['total']} (dont caution)")

    # Le montant de location extrait du devis fige : 3 x 60 000.
    location = sql(
        f"SELECT pricing_snapshot->>'rentalAmount' FROM booking WHERE id='{reservation}';"
    )
    verifier("devis fige : montant de location distinct du total", location == "180000",
             f"location={location}")
    verifier("devis fige : total inclut la caution",
             sql(f"SELECT total_amount FROM booking WHERE id='{reservation}';") == "680000")

    # ------------------------------------------------------------------
    dire("")
    dire("=== 1. ouverture d intention ===")

    st, p = appeler("POST", "/payments/intents",
                    {"bookingId": reservation, "method": "mobile_money"},
                    jeton=client["token"])

    verifier("intention ouverte", st == 201, f"{st} {p.get('message')}")
    verifier("montant = location, NON le total", p.get("amount") == "180000",
             f"montant={p.get('amount')} (total=680000)")
    verifier("genre = rental, pas la caution", p.get("kind") == "rental")
    verifier("statut initial = pending", p.get("status") == "pending")
    verifier("instruction client presente", bool(p.get("instructions")))
    verifier("aucune date d encaissement", p.get("paidAt") is None)

    paiement = p.get("id")
    reference_externe = p.get("externalRef")

    # ------------------------------------------------------------------
    dire("")
    dire("=== 2. le webhook refuse ce qui doit l etre ===")

    st, r = appeler("POST", "/payments/webhook/simulator",
                   brut=notification(reference_externe, "paid"))
    verifier("webhook SANS signature refuse", st == 403, f"statut {st}")

    charge = notification(reference_externe, "paid")
    st, r = appeler("POST", "/payments/webhook/simulator", brut=charge,
                    signature="0" * 64)
    verifier("webhook avec MAUVAISE signature refuse", st == 403, f"statut {st}")

    st, r = appeler("POST", "/payments/webhook/inexistant", brut=charge, signature=signer(charge))
    verifier("prestataire inconnu refuse", st == 404, f"statut {st}")

    # La signature porte sur les OCTETS. Modifier le corps apres signature
    # doit etre detecte — c'est ce que le corps brut garantit.
    st, r = appeler("POST", "/payments/webhook/simulator",
                   brut=notification(reference_externe, "paid", montant="1"),
                   signature=signer(charge))
    verifier("corps modifie apres signature refuse", st == 403, f"statut {st}")

    # ------------------------------------------------------------------
    dire("")
    dire("=== 3. notification signee : le parcours nominal ===")

    charge = notification(reference_externe, "paid", identifiant=f"evt-e2e-1-{SUFFIXE}")
    st, r = appeler("POST", "/payments/webhook/simulator", brut=charge,
                    signature=signer(charge))

    verifier("notification appliquee", st == 200, f"{st} {r.get('message')}")
    verifier("issue = applied", r.get("outcome") == "applied")
    verifier("paiement = paid", r.get("status") == "paid")

    statut_reservation = sql(f"SELECT status FROM booking WHERE id='{reservation}';")
    verifier("reservation passee a paid", statut_reservation == "paid", statut_reservation)

    date_encaissement = sql(f"SELECT paid_at IS NOT NULL FROM payment WHERE id='{paiement}';")
    verifier("date d encaissement posee par la base", date_encaissement == "t")

    # ------------------------------------------------------------------
    dire("")
    dire("=== 4. le doublon : le risque reel ===")

    commission_avant_doublon = commission_du_proprietaire()

    st, r = appeler("POST", "/payments/webhook/simulator", brut=charge,
                    signature=signer(charge))

    verifier("doublon accepte en 200", st == 200, f"statut {st}")
    verifier("doublon IGNORE, pas reapplique", r.get("outcome") == "ignored_duplicate",
             f"outcome={r.get('outcome')}")

    # Comparer le MONTANT avant et apres la retransmission.
    #
    # `provider_ledger` est un agregat par partenaire : il ne porte pas de
    # `booking_id`, et la colonne n existe pas. Compter des lignes y
    # echouerait — et le helper SQL masquant `stderr`, l echec aurait ete
    # lu comme un zero, donc comme un succes.
    #
    # Une difference de montant est de surcroit plus sensible qu'un
    # compteur : deux lignes peuvent se compenser, deux montants non.
    commission_apres = commission_du_proprietaire()
    verifier("aucune commission creditee en double",
             commission_apres == commission_avant_doublon,
             f"{commission_avant_doublon} -> {commission_apres}")

    evenements = sql(
        "SELECT count(*) FROM provider_webhook_delivery "
        "WHERE external_event_id = 'evt-e2e-1-%s';" % SUFFIXE
    )
    verifier("un seul enregistrement pour cet evenement", evenements == "1", evenements)

    # ------------------------------------------------------------------
    dire("")
    dire("=== 5. la base refuse le retour en arriere ===")

    resultat = sql(
        f"UPDATE payment SET status = 'pending' WHERE id = '{paiement}';"
    )

    verifier("paid -> pending refuse par la base",
             "payment_transition_not_allowed" in resultat,
             resultat[:140] or "la transition a abouti — elle ne devrait pas")

    verifier("paiement toujours paye apres tentative",
             sql(f"SELECT status FROM payment WHERE id='{paiement}';") == "paid")

    # ------------------------------------------------------------------
    dire("")
    dire("=== 6. encaissement sur reservation annulee ===")

    st, r2 = appeler("POST", "/bookings", {
        "vehicleId": vehicule,
        "startAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base + 10 * 86_400)),
        "endAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base + 12 * 86_400)),
        "isOneWay": False,
    }, jeton=client["token"])
    assert st == 201, f"deuxieme reservation : {st} {r2.get('message')}"
    reservation2 = r2["id"]

    st, p2 = appeler("POST", "/payments/intents",
                     {"bookingId": reservation2, "method": "mobile_money"},
                     jeton=client["token"])
    assert st == 201, f"intention 2 : {st} {p2.get('message')}"
    ref2 = p2["externalRef"]

    # La version est LUE, pas devinee. Le verrou optimiste refuse une
    # ecriture fondee sur une lecture perimee — c'est son travail, et un
    # test qui passe `1` en dur finirait par echouer sans que rien du
    # produit n ait change.
    version = sql(f"SELECT version FROM booking WHERE id='{reservation2}';")

    st, r = appeler("POST", f"/bookings/{reservation2}/cancel", {
        "by": "client", "reason": "Changement de programme",
        "expectedVersion": int(version),
    }, jeton=client["token"])
    verifier("reservation annulee", st in (200, 204),
             f"statut {st} — {r.get('code', '')} {r.get('message', '')}".strip())

    charge2 = notification(ref2, "paid", montant="120000", identifiant=f"evt-e2e-2-{SUFFIXE}")
    st, r = appeler("POST", "/payments/webhook/simulator", brut=charge2,
                    signature=signer(charge2))

    verifier("encaissement tardif REFUSE", st >= 400, f"statut {st} outcome={r.get('outcome')}")
    verifier("paiement 2 non encaisse",
             sql(f"SELECT status FROM payment WHERE id='{p2['id']}';") == "pending",
             sql(f"SELECT status FROM payment WHERE id='{p2['id']}';"))

    # ------------------------------------------------------------------
    dire("")
    dire("=== 7. un montant annonce different est refuse ===")

    st, r3 = appeler("POST", "/bookings", {
        "vehicleId": vehicule,
        "startAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base + 20 * 86_400)),
        "endAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base + 22 * 86_400)),
        "isOneWay": False,
    }, jeton=client["token"])
    assert st == 201, f"troisieme reservation : {st}"

    st, p3 = appeler("POST", "/payments/intents",
                     {"bookingId": r3["id"], "method": "card"}, jeton=client["token"])
    assert st == 201, f"intention 3 : {st}"

    # 999 999 au lieu de 120 000 : le prestataire aurait traite une autre
    # commande. Encaisser ce montant serait facturer n'importe quoi.
    charge3 = notification(p3["externalRef"], "paid", montant="999999",
                           identifiant=f"evt-e2e-3-{SUFFIXE}")
    st, r = appeler("POST", "/payments/webhook/simulator", brut=charge3,
                    signature=signer(charge3))

    verifier("ecart de montant refuse", st >= 400, f"statut {st}")
    verifier("paiement 3 non encaisse",
             sql(f"SELECT status FROM payment WHERE id='{p3['id']}';") == "pending")

    # ------------------------------------------------------------------
    dire("")
    dire("=== 8. acces aux paiements d autrui ===")

    st, r = appeler("GET", f"/payments/{paiement}", jeton=proprietaire["token"])
    verifier("paiement d autrui invisible (404)", st == 404, f"statut {st}")

    st, r = appeler("GET", f"/payments/{paiement}", jeton=client["token"])
    verifier("son propre paiement visible", st == 200, f"statut {st}")

    st, r = appeler("GET", f"/payments/{paiement}")
    verifier("paiement sans session refuse", st == 401, f"statut {st}")

    # ------------------------------------------------------------------
    dire("")
    dire(f"RESULTAT : {reussis} reussis, {echecs} echecs sur {reussis + echecs}")
    return 0 if echecs == 0 else 1


sys.exit(main())
