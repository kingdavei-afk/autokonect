import { Kysely, PostgresDialect, sql, type KyselyConfig } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

import type { Database } from './types.js';

export type Db = Kysely<Database>;

export interface DatabaseOptions {
  connectionString: string;
  /** Nombre maximum de connexions du pool. */
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  /** Affiche les requetes : uniquement en developpement (CDCS 11.8). */
  debug?: boolean;
}

function parseConnectionString(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || undefined,
    ssl: url.searchParams.get('sslmode')
      ? { rejectUnauthorized: url.searchParams.get('sslmode') !== 'disable' }
      : undefined,
  };
}

/**
 * Cree une instance Kysely.
 *
 * Choix technique : Kysely plutot qu'un ORM a generation de code
 * (voir docs/adr/ADR-002-outillage-base-de-donnees.md). Le schema
 * repose sur des triggers, des index partiels et des vues que les ORM
 * n'expriment pas dans leur langage natif.
 */
export function createDatabase(options: DatabaseOptions): Db {
  const pool = new Pool({
    ...parseConnectionString(options.connectionString),
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  });

  // Une erreur sur une connexion inactive ne doit pas faire tomber le
  // processus : elle doit etre journalisee puis la connexion relassee.
  pool.on('error', (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pool.error',
        err: error.message,
      }),
    );
  });

  const config: KyselyConfig<Database> = {
    dialect: new PostgresDialect({ pool }),
  };

  return new Kysely<Database>(config);
}

/** Verifie que la base repond. Utilise par le endpoint de sante (CDCS 15.2). */
export async function ping(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}