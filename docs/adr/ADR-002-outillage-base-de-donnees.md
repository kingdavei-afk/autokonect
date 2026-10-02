# ADR-002 — Outillage d'accès aux données : Kysely plutôt que Prisma

- **Statut** : accepté
- **Date** : 2026-10-02
- **Porte la contradiction avec** : CDCS §15.4 (mentionne `Prisma migrate`)

## Contexte

Le CDC v2.0 (CDCS §15.4) prévoyait Prisma pour l'accès aux données.
Cette décision a été prise avant d'avoir écrit le schéma. Une fois le
schéma réel construit (41 tables, 27 triggers), trois besoins sont
apparus que le langage de Prisma n'exprime pas :

1. **Un trigger d'exclusion de chevauchement** (`prevent_booking_overlap`)
   qui porte la règle métier la plus critique du produit : deux
   réservations concurrentes sur les mêmes dates doivent être impossibles
   (CDCS §8.2).
2. **Un `tsvector` maintenu par trigger** sur `vehicle`, nécessaire parce
   que PostgreSQL **interdit les sous-requêtes dans une colonne
   générée** — et la catégorie doit intervenir dans l'index de recherche.
3. **Un trigger générique `updated_at`** appliqué par un bloc `DO`
   parcourant 22 tables.

Avec Prisma, ces trois éléments doivent être écrits en SQL dans les
fichiers de migration, **en plus** d'un `schema.prisma` qui redéclare les
41 modèles. On se retrouve alors avec deux déclarations du même schéma,
qui divergent silencieusement.

## Décision

**Kysely** pour l'accès aux données, et **SQL brut** comme source de
vérité unique du schéma.

- `packages/database/migrations/0001_init.sql` est la seule déclaration
  du modèle.
- `packages/database/src/types.ts` en est le reflet TypeScript, revu à la
  main.
- Les migrations sont des fichiers `.sql` numérotés, appliqués par un
  runner maison transactionnel.

## Conséquences

### Positives

- **Une seule source de vérité.** Pas de `schema.prisma` à resynchroniser.
- **SQL complet disponible.** Les triggers, index partiels, contraintes
  d'exclusion et vues s'écrivent naturellement.
- **Pas d'étape de génération.** `pnpm install` suffit ; pas de
  téléchargement de moteur, pas de `generate` à oublier, pas de
  `prisma generate` cassé après un `pnpm install --frozen-lockfile`.
- **Requêtes typées sans code généré.** L'autocomplétion porte sur les
  vrais noms de colonnes ; une colonne renommée casse la compilation
  immédiatement.
- **Les règles métier sont imposées par la base**, donc invérifiables par
  le code applicatif. C'est vérifié par `pnpm db:test`.

### Négatives

- **Pas de migrations automatiques.** La migration est écrite à la main.
  C'est un coût réel, accepté : le schéma est peu volatile et chaque
  règle est discutable, ce qui est un atout à ce stade du projet.
- **Pas de client généré.** Les résultats des requêtes sont typés par les
  types du package, mais le mapping reste manuel dans les repositories.
- **Types `bigint`.** Le driver `pg` renvoie les `int8` sous forme de
  chaîne. Les types `MoneyInt`, `Ratio` et `Timestamp` documentent ce
  comportement pour éviter une perte de précision silencieuse sur les
  montants (CDCS §4.3).

## Statut par rapport au CDC

Le CDCS §15.4 doit être amendé : remplacer `Prisma migrate` par
`pnpm db:migrate` (runner Kysely + SQL). Le reste de la section
(Versioning Semantique, migrations non destructives, déploiement manuel
validé) reste valable.

## Risque accepté

La duplication `types.ts` ↔ `0001_init.sql` peut dériver. Elle est
maîtrisée par un test de non-régression : toute nouvelle colonne du SQL
non répercutée dans `types.ts` provoque une erreur de compilation dès la
première requête qui l'utilise.