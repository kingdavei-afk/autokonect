/**
 * @adkcars/database
 *
 * Point d'entree unique vers la base : fabrique de connexion, runner de
 * migrations, types de lignes. Aucun module applicatif ne doit ouvrir
 * sa propre connexion `pg` : tout passe par `createDatabase` afin que
 * le pool, le timeout et la journalisation restent homogenes.
 */

// Reexporte pour permettre `import { sql } from '@adkcars/database'`
// sans obliger chaque service a dependre directement de kysely.
export { sql } from 'kysely';
export type {
  Expression,
  ExpressionBuilder,
  ExtractTypeFromReferenceExpression,
  Selectable,
  SqlBool,
  /**
   * Transaction Kysely.
   *
   * Exportee pour que l'API puisse typer le `trx` d'une methode interne :
   * Kysely l'infere quand la fonction est appelee en ligne, mais pas pour
   * une methode appelee ailleurs.
   *
   * Importer depuis `kysely` directement ferait dependre l'API du
   * CONSTRUCTEUR plutot que du paquet qui l'encapsule — le jour ou ce
   * paquet isole Kysely, l'API devrait etre modifiee.
   *
   * `any` serait l'autre solution, et elle est mauvaise : une transaction
   * dont le type est faux produit une erreur a l'EXPLOITATION, en
   * production, sur une ecriture qu'on croyait verifiee.
   */
  Transaction,
} from 'kysely';

export {
  createDatabase,
  isTransactionPooler,
  ping,
  type DatabaseOptions,
  type Db,
} from './connection.js';

export {
  appliedMigrations,
  loadMigrations,
  migrate,
  reset,
  status,
  type AppliedMigration,
  type MigrateOptions,
  type MigrateResult,
  type MigrationFile,
  type MigrationStatus,
} from './migrator.js';

export type * from './types.js';