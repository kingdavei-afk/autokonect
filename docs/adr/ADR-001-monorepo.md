# ADR-001 — Monorepo, un seul dépôt pour le web, l'API et le mobile

- **Statut** : accepté
- **Date** : 2026-10-02
- **Référence** : CDCS §10.3

## Contexte

Le produit comporte trois surfaces de code : le site web et le
back-office (Next.js), l'API (NestJS) et l'application mobile (Flutter).
Elles partagent des contrats métier : les statuts de réservation, la
machine à états, les règles de commission, les types de montants.

En répartissant ces surfaces dans des dépôts séparés, chaque contrat
vituel est dupliqué. C'est la source classique de désynchronisation
silencieuse : l'API accepte un état, le mobile ne sait pas l'afficher,
et le bug n'apparaît qu'en production.

## Décision

**Un dépôt unique** (`monorepo`), structuré :

```
apps/
  api/        NestJS — API REST
  web/        Next.js — site + back-office
  mobile/     Flutter — Android et iOS
packages/
  contracts/  types et schémas partagés (Zod + TypeScript)
  database/   accès base : types Kysely, runner de migrations, fixtures
docs/         CDC, ADR, schémas
infra/        Terraform
```

Points structurants :

- **Un seul `pnpm install`, un seul pipeline de qualité.**
- **Un seul commit** peut modifier l'API et le mobile ensemble. C'est ce
  qui rend l'atomicité réalisable.
- **`packages/contracts` est la source de vérité des contrats.** Les
  schémas Zod d'entrée/sortie y vivent ; l'API les applique et le front
  s'en sert pour typer ses appels.
- **Un seul tooling** : un TypeScript, un Prettier, un ESLint, un
  arbitrage de versions.

## Conséquences

### Positives

- Un changement de machine à états de la réservation est un commit
  unique qui touche le schéma, l'API et les deux clients.
- Les types ne dérivent pas : `pnpm typecheck` échoue si un contrat
  change sans être répercuté.
- Un versionnement unique, donc une traçabilité simple entre une
  fonctionnalité et son deploy.

### Négatives

- **Le build global est plus lent** qu'une suite de dépôts. Atténué par
  les filtres pnpm (`--filter`) et par le cache de compilation.
- **Tout le monde a accès à tout le code.** Acceptable : une seule équipe,
  et les clauses de confidentialité portent sur les livrables, pas sur le
  dépôt.
- **La frontière de déploiement est moins nette.** Chaque application
  reste déployable indépendamment ; seul le *commit* est commun.

## Options écartées

| Option | Pourquoi écartée |
|---|---|
| Dépôts séparés avec versions partagées | Versions de contrats à gérer, dérive silencieuse garantie sur 3 surfaces. |
| Monorepo sans `packages/contracts` | Les types resteraient dupliqués, ce qui annule le bénéfice du monorepo. |
| API seule pour l'instant, front plus tard | Retarde la détection des divergences de contrat, qui est précisément ce que le monorepo doit prévenir. |

## Point non résolu

Le **back-office** reste à trancher (arbitrage **A-09** du CDCS §19) :
trois applications distinctes, ou une application unique à rôles ? La
recommandation du CDCS est l'application unique à rôles, internes
cloisonnés. Le monorepo ne tranche pas la question ; il permet les deux.