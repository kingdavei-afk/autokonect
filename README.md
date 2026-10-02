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
  RBAC par rôle. 20 tests unitaires, 22 tests de parcours.
- Instance PostgreSQL 16.10 portable pour le développement local.

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
| `pnpm db:test` | **10 tests de règles métier sur base réelle** |

### Tests du parcours d'authentification

```powershell
# API démarrée sur :3000, base migrée
.\apps\api\test\auth-flow.ps1
```

22 vérifications de bout en bout : inscription, vérification OTP,
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

---

## Documents de référence

- [Cahier des charges v2.0](AdkCars-CI_CDC-v2.0.md) — 21 chapitres,
  105 fonctionnalités priorisées, 16 arbitrages à trancher
- [ADR-001 — Monorepo](docs/adr/ADR-001-monorepo.md)
- [ADR-002 — Kysely plutôt que Prisma](docs/adr/ADR-002-outillage-base-de-donnees.md)

## Points bloquants à trancher

Les 16 arbitrages du CDCS §19 conditionnent le chiffrage. Cinq sont
critiques et bloquent l'avancement :

| # | Décision | Effet si non tranchée |
|---|---|---|
| A-01 | Modèle de flux financier | Le module Paiement ne peut pas être écrit |
| A-02 | PSP de référence et opérateur Mobile Money P1 | Le MVP ne peut pas encaisser |
| A-04 | Gestion de la caution | Pas d'encours, pas de restitution |
| A-09 | Back-office unique ou 3 applications | Écart de coût majeur |
| A-15 | Budget cible et financement | Aucun chiffrage fiable |