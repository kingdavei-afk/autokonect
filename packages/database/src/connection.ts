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

/** Port du pooler Supabase en mode transaction (A-18). */
const SUPABASE_TRANSACTION_POOLER_PORT = 6543;

/**
 * La chaine de connexion passe-t-elle par un pooler en mode transaction ?
 *
 * Ce mode sert une transaction par connexion physique : les etats de
 * session ne survivent pas d'une transaction a l'autre. C'est la
 * contrepartie de sa resistance a la multiplication des connexions.
 */
export function isTransactionPooler(connectionString: string): boolean {
  try {
    return new URL(connectionString).port === String(SUPABASE_TRANSACTION_POOLER_PORT);
  } catch {
    return false;
  }
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
  const url = parseConnectionString(options.connectionString);

  const pool = new Pool({
    ...url,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,

    // ------------------------------------------------------------------------
    // Hebergement a invocations ephemeres (A-18)
    // ------------------------------------------------------------------------
    // Sans ce drapeau, un pool contenant encore des connexions inactives
    // maintient le processus en vie. Sur un serveur unique c'est
    // desirable ; sur une fonction serverless, cela empeche la reclamation
    // de l'instance et l'on paie une instance maintenue pour rien.
    allowExitOnIdle: true,
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

  if (isTransactionPooler(options.connectionString)) {
    // ------------------------------------------------------------------------
    // Mode transaction : ce qui devient interdit
    // ------------------------------------------------------------------------
    // Le pooler rend une connexion physique apres chaque transaction,
    // donc rien de niveau session ne survit : `SET` persists, verrous
    // consultatifs de session, `LISTEN`, et surtout les prepared
    // statements nommes.
    //
    // `node-postgres` n'utilise PAS de prepared statement nomme par
    // defaut : il passe par le protocole etendu avec des instructions
    // sans nom, ce qui est compatible. Le code applicatif n'en cree
    // aucun (Kysely n'en cree pas davantage).
    //
    // Ce message est donc une SURVEILLANCE, pas une correction : si une
    // dependance introduisait un jour des prepared statements nommes,
    // l'erreur serait "`prepared statement already exists`" en
    // production, sur une requete et non au demarrage. Ce rappel la
    // rend visible au bon moment.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'database.transaction_pooler',
        detail:
          'Mode transaction (port 6543) : les prepared statements nommes, ' +
          'SET persistants et LISTEN sont indisponibles. Les migrations ' +
          'doivent utiliser DIRECT_DATABASE_URL (port 5432).',
      }),
    );
  }

  const config: KyselyConfig = {
    dialect: new PostgresDialect({ pool }),
  };

  return new Kysely<Database>(config);
}

/** Verifie que la base repond. Utilise par le endpoint de sante (CDCS 15.2). */
export async function ping(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}
