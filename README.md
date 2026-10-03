# AdkCars CI (AutoKonnect)

Plateforme SaaS de location de véhicules — Côte d'Ivoire.

Dépôt unique pour l'API, le site web, le back-office et l'application
mobile (CDCS §10.3, voir [ADR-001](docs/adr/ADR-001-monorepo.md)).

---

## État d'avancement

| Phase | Contenu | Statut |
|---|---|---|
| **P0** Socle | Infrastructure, données, authentification, CI/CD | 🔵 En cours |
| P1 MVP | Réserver, payer, publier | ⚪ Non démarré |
| P2 v1 | Monétisation, caution, contrat, Android | ⚪ Non démarré |
| P3 Écosystème | iOS, temps réel, chauffeur | ⚪ Non démarré |
| P4 IA & expansion | IA, multi-pays | ⚪ Non démarré |

**Realisé dans P0 à ce jour**

- Monorepo pnpm, TypeScript strict, garde-fous d'import.
- Schéma de base de données : **41 tables, 122 index, 201 contraintes,
  27 triggers**, montants en `bigint`, clés UUID, horodatage UTC.
- Règles métier **imposées par la base** et vérifiées par `pnpm db:test`
  (10 tests, tous au vert).
- API NestJS : configuration validée au démarrage, journal JSON, sondes de
  vivacité et de disponibilité, format d'erreur unique, limitation de
  débit.
- **Authentification complète** : inscription, OTP téléphone, connexion,
  mot de passe oublié, sessions ; jeton d'accès JWT de 15 min et jeton de
  rafraîchissement opaque avec rotation et détection de réutilisation ;
  RBAC par rôle.
- **Contrats partagés** (`@adkcars/contracts`) : machine à états de
  réservation (14 états, graphe testé exhaustivement), type monétaire
  nominal `Centimes`, schémas véhicule.
- **Module véhicules** : publication, cycle de validation documentaire,
  recherche géolocalisée avec filtres et disponibilité.
- **Back-office de validation** : file de revue, examen des documents,
  décision motivée, publication. Un véhicule ne devient visible qu'après
  validation d'un administrateur et validation de ses documents.
- **Modèle financier acté** (A-01, A-05, A-07) : la plateforme encaisse
  puis reverse au partenaire ; les commissions varient par partenaire,
  sont résolues par priorité et figées sur la réservation ; **aucune TVA
  n'est collectée**. Vue `provider_ledger` pour la trésorerie de chaque
  partenaire.
- Instance PostgreSQL 16.10 portable pour le développement local.

**Bilan des tests : 265 au vert**

| Suite | Volume |
|---|---|
| Règles métier en base (`pnpm db:test`) | 11 |
| Commission et trésorerie (`pnpm db:commission`) | 23 |
| Privilèges du rôle applicatif (`pnpm db:privileges`) | 8 |
| Contrats partagés (Vitest) | 102 |
| API (Vitest) | 33 |
| Parcours authentification (bout en bout) | 22 |
| Parcours véhicule (bout en bout) | 23 |
| Back-office de validation (bout en bout) | 26 |
| Flux temps réel SSE (bout en bout) | 17 |

### Surface d'API

| Méthode | Route | Accès |
|---|---|---|
| `GET` | `/` | public |
| `GET` | `/health/live` | public |
| `GET` | `/health/ready` | public (503 si base indisponible) |
| `POST` | `/auth/register` | public, 5/min |
| `POST` | `/auth/verify-phone` | public, 5/min |
| `POST` | `/auth/login` | public, 10/min |
| `POST` | `/auth/refresh` | public, 30/min |
| `POST` | `/auth/password/forgot` | public, 3/5 min |
| `POST` | `/auth/password/reset` | public, 5/5 min |
| `POST` | `/auth/password/change` | authentifié |
| `POST` | `/auth/logout` | authentifié |
| `POST` | `/auth/logout-all` | authentifié |
| `GET` | `/auth/me` | authentifié |
| `GET` | `/vehicles` | authentifié, recherche |
| `GET` | `/vehicles/mine` | authentifié |
| `GET` | `/vehicles/:id` | authentifié |
| `GET` | `/vehicles/:id/publication-readiness` | propriétaire ou admin |
| `POST` | `/vehicles` | propriétaire |
| `PATCH` | `/vehicles/:id` | propriétaire ou admin |
| `POST` | `/vehicles/:id/documents` | propriétaire ou admin |
| `POST` | `/vehicles/:id/submit` | propriétaire ou admin |
| `GET` | `/admin/vehicles` | admin, file de revue |
| `GET` | `/admin/vehicles/:id` | admin, examen |
| `POST` | `/admin/vehicles/:id/documents/review` | admin |
| `POST` | `/admin/vehicles/:id/decision` | admin, publier ou refuser |
| `GET` | `/realtime/events` | authentifié, flux SSE |
| `GET` | `/realtime/status` | authentifié, état du transport |

Toute route non listée est **protégée par défaut** : l'oubli du
décorateur `@Public` est impossible par construction.

---

## Prérequis

| Outil | Version | Commentaire |
|---|---|---|
| Node.js | ≥ 22 | 24.18.1 utilisé |
| pnpm | ≥ 10 | `npm i -g pnpm@10` si absent |
| Git | ≥ 2.30 | |
| PostgreSQL | 16 | **Optionnel** : voir ci-dessous |

> `pnpm` n'est pas requis globalement. Corepack fonctionne si le
> répertoire `C:\Program Files\nodejs` est inscriptible ; sinon
> `npm config set prefix "$env:APPDATA\npm"` puis `npm i -g pnpm@10`.

### Base de données locale : deux options

**Option A — portable (retenue ici, aucun droit administrateur requis)**

Les binaires PostgreSQL 16.10 sont déployés dans `.tools/`, hors dépôt
git. Le cluster est initialisé automatiquement.

```powershell
.\scripts\dev-db.ps1 start     # démarre
.\scripts\dev-db.ps1 status    # état + taille des bases
.\scripts\dev-db.ps1 stop      # arrête
```

**Option B — Docker** (à privilégier pour toute installation partagée)

```bash
docker compose up -d
pnpm db:migrate
```

---

## Démarrage

```powershell
# 1. Dépendances
pnpm install

# 2. Variables d'environnement
Copy-Item .env.example .env

# 3. Base de données
.\scripts\dev-db.ps1 start
pnpm db:migrate

# 4. API
pnpm dev:api          # http://localhost:3000
```

Vérification :

```powershell
curl.exe http://127.0.0.1:3000/health/live
curl.exe http://127.0.0.1:3000/health/ready
```

---

## Commandes

| Commande | Effet |
|---|---|
| `pnpm dev:api` | API en mode rechargement |
| `pnpm build` | Compile tous les packages |
| `pnpm typecheck` | Vérification de types (bloquant) |
| `pnpm test` | Tests unitaires |
| `pnpm db:migrate` | Applique les migrations en attente |
| `pnpm db:migrate:status` | État des migrations |
| `pnpm db:reset` | Recrée le schéma (développement uniquement) |
| `pnpm db:test` | **11 tests de règles métier sur base réelle** |
| `pnpm db:commission` | **23 tests de commission et de trésorerie** |
| `pnpm db:privileges` | **8 tests du contrat de privilèges (CDCS 12.1)** |
| `.\scripts\dev-api.ps1` | Démarre l'API en arrière-plan, journaux exploitables |
| `.\scripts\dev-api.ps1 -Stop` | Arrête l'API démarrée par le script |

### Tests de bout en bout

```powershell
.\scripts\dev-db.ps1 start
pnpm build
.\scripts\dev-api.ps1          # attend une réponse HTTP réelle avant de rendre la main

.\apps\api\test\auth-flow.ps1      # 22 vérifications
.\apps\api\test\vehicles-flow.ps1  # 23 vérifications
.\apps\api\test\admin-flow.ps1     # 26 vérifications
.\apps\api\test\realtime-flow.ps1  # 17 vérifications
```

Ces tests lisent le code OTP dans `apps\api\api.err.log`, écrit par le
fournisseur SMS simulé. Ils supposent donc que l'API a été démarrée par
`scripts\dev-api.ps1` : sans redirection de la sortie d'erreur, le code
est introuvable et le parcours échoue sur un « 401 » sans explication.

Le parcours temps réel ouvre un flux SSE sur une connexion TCP brute et
vérifie qu'un événement produit **après** l'ouverture est bien reçu — un
flux qui ne rejoue que l'historique passerait sinon pour fonctionnel.

22 vérifications d'authentification : inscription, vérification OTP,
rotation des jetons, détection de réutilisation, non-énumération des
comptes, limitation de débit.

> Le script attend 62 s s'il rencontre un `429` : le limiteur de débit
> compte par IP et toutes les requêtes viennent de `127.0.0.1`. C'est un
> comportement attendu, pas un contournement de test.

---

## Structure

```
apps/
  api/                      NestJS — API REST
packages/
  database/                 types Kysely, runner de migrations
    migrations/0001_init.sql   SOURCE DE VÉRITÉ du schéma
    tests/                     tests de règles métier
  contracts/                contrats partagés (à venir)
scripts/
  db/00-provision.sql       rôles, bases, extensions
  dev-db.ps1                pilotage de PostgreSQL local
docs/
  adr/                      décisions d'architecture
AdkCars-CI_CDC-v2.0.md      cahier des charges
```

---

## Règles de conception non négociables

Ces règles viennent du CDC et sont appliquées par le code, pas seulement
écrites.

1. **Les montants sont des entiers en centimes** (`bigint`). Jamais de
   flottant. Jamais de division en virgule flottante.
2. **Toute règle métier critique est une contrainte de base.** Le double
   chevauchement de réservation, l'exclusivité agence/propriétaire,
   l'unicité de l'avis par location et l'idempotence du paiement sont
   vérifiés par la base, pas seulement par le code.
3. **Toute route est privée par défaut.** L'interface n'est jamais la
   frontière de sécurité : la vérification est côté API.
4. **Aucune donnée sensible dans les journaux.** Les clés sensibles sont
   masquées avant écriture, récursivement.
5. **La configuration est validée au démarrage.** Un secret manquant
   empêche le démarrage au lieu de provoquer une erreur à 3 h du matin.
6. **Un secret de développement ne démarre jamais en production.** La
   validation le refuse explicitement.
7. **Deux rôles de base distincts.** L'application utilise un rôle
   restreint ; le rôle privilégié est réservé aux migrations. Un garde-fou
   refuse le démarrage si les deux sont identiques.
8. **Une migration appliquée ne change plus.** Son empreinte est
   vérifiée ; toute divergence est signalée.
9. **Toute transition d'état de réservation est journalisée** : acteur,
   horodatage, état source, état cible.
10. **La sortie standard est du JSON**, sans exception, framework inclus.
11. **Toute erreur 5xx est journalisée avec sa pile**, corrélée par
    `request_id`. Une erreur non journalisée est un bug sans diagnostic.
12. **Un véhicule n'est jamais publié directement** : il passe par la
    validation documentaire puis par un administrateur.
13. **Un compte qui n'est pas le propriétaire reçoit 404, pas 403** —
    répondre « interdit » confirmerait l'existence de l'annonce.
14. **Un refus administratif est toujours motivé.** Un refus sans motif
    est inexploitable pour le fournisseur ; le schéma l'exige (400).
17. **Le taux de commission se résout par priorité** — surcharge du
    partenaire, puis formule, puis défaut plateforme — puis est **figé sur
    la réservation**. Une facture déjà présentée ne doit jamais bouger.
18. **Les fonds détenus sont ségrégués** : caution du client, solde dû au
    partenaire et commission de la plateforme sont comptabilisés
    séparément dans `provider_ledger`.
19. **Aucune TVA n'est collectée** (A-19). L'état est explicite et
    vérifiable — `platform.vat_registered = false`, `payout.tax_amount`
    contrainte à zéro — et non une simple colonne manquante.
20. **La séparation des privilèges existe en SQL, pas seulement en
    intention** (CDCS 12.1). Le rôle `adkcars_app` porte les droits
    minimaux, `NOLOGIN`, sans mot de passe ; le compte de connexion n'en
    est que membre et n'hérite d'aucune propriété. Huit tests vérifient
    que l'application **peut** écrire et **ne peut pas** créer,
    supprimer ni altérer un objet.
21. **La limitation de débit ne dépend jamais de la mémoire d'une
    instance** (A-18). Le stockage par défaut de `@nestjs/throttler`
    étant une `Map` du processus, elle serait réinitialisée à chaque
    invocation en hébergement éphémère — et le code OTP deviendrait
    forçable. Redis partagé est donc **obligatoire** en production :
    l'application refuse de démarrer sans.
22. **Aucune information d'état en mémoire entre deux requêtes**
    (A-18). Une instance peut être détruite sans préavis. Tout ce qui
    doit survivre est dans PostgreSQL — c'est pourquoi le temps réel
    passe de Socket.IO à SSE et pourquoi le volume du pool vaut 1.
15. **Un véhicule publié dont le tarif change repasse en validation.**
    La modification doit être revue avant de redevenir visible.
16. **La publication est bloquée si un document obligatoire est
    expiré**, même marqué valide en base : la date passe avant le statut.

---

## Documents de référence

- [Cahier des charges v2.0](AdkCars-CI_CDC-v2.0.md) — 21 chapitres,
  105 fonctionnalités priorisées, 19 arbitrages (5 résolus)
- [ADR-001 — Monorepo](docs/adr/ADR-001-monorepo.md)
- [ADR-002 — Kysely plutôt que Prisma](docs/adr/ADR-002-outillage-base-de-donnees.md)
- [ADR-003 — Vercel et Supabase](docs/adr/ADR-003-hebergement-vercel-supabase.md)

## Points bloquants à trancher

Les arbitrages du CDCS §19 conditionnent le chiffrage. Sur les 19, cinq
sont résolus. Restent ceux-ci :

| # | Décision | Effet si non tranchée |
|---|---|---|
| A-02 | PSP de référence et opérateur Mobile Money P1 | Le MVP ne peut pas encaisser |
| A-04 | Gestion de la caution | Pas d'encours, pas de restitution |
| A-15 | Budget cible et financement | Aucun chiffrage fiable |

### Résolus

| # | Décision | Conséquence à surveiller |
|---|---|---|
| A-01 | Modèle B : la plateforme encaisse puis reverse | Trésorerie et ségrégation des fonds |
| A-05 | Commissions variables par partenaire | Grille commerciale finale à définir |
| A-17 | SSE au lieu de Socket.IO | Perte du bidirectionnel, reprise plus robuste |
| A-18 | Vercel + Supabase | Redis partagé obligatoire, workers hors Vercel |
| A-19 | Aucune TVA collectée | **À confirmer par un fiscaliste avant tout encaissement réel** |