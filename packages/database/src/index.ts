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