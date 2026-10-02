#!/usr/bin/env node
/**
 * CLI de migration.
 *
 *   pnpm db:migrate            applique les migrations en attente
 *   pnpm db:migrate:status     affiche l'etat du schema
 *   pnpm db:reset              recree le schema (developpement uniquement)
 */
import { config as loadEnv } from 'dotenv';

import { createDatabase, type Db } from './connection.js';
import { migrate, reset, status } from './migrator.js';

loadEnv({ path: new URL('../../../.env', import.meta.url) });

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'up';
  const connectionString = process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'];

  if (!connectionString) {
    log('ERREUR  DATABASE_URL ou DIRECT_DATABASE_URL absent du fichier .env');
    return 1;
  }

  const db: Db = createDatabase({ connectionString, max: 2 });

  try {
    switch (command) {
      case 'up': {
        const result = await migrate(db, { logger: log });
        log('');
        log(`appliquees  : ${result.applied.length}  ${result.applied.join(', ') || '-'}`);
        log(`ignorees    : ${result.skipped.length}`);
        log(`derivees    : ${result.drifted.length}`);
        return result.drifted.length > 0 ? 2 : 0;
      }

      case 'status': {
        const rows = await status(db);
        for (const row of rows) {
          const mark = row.applied ? (row.drift ? 'D' : 'x') : ' ';
          const when = row.appliedAt
            ? row.appliedAt.toISOString().replace('T', ' ').slice(0, 19)
            : '-';
          log(`[${mark}] ${row.name.padEnd(28)} ${when}`);
        }
        return 0;
      }

      case 'reset': {
        if (process.env['NODE_ENV'] === 'production') {
          log('ERREUR  reset interdit en production');
          return 1;
        }
        const result = await reset(db, { logger: log });
        log('');
        log(`schema recree, ${result.applied.length} migration(s) appliquee(s)`);
        return 0;
      }

      default:
        log(`Commande inconnue : ${command}`);
        log('Commandes disponibles : up | status | reset');
        return 1;
    }
  } catch (error) {
    const err = error as Error;
    log(`ERREUR  ${err.message}`);
    return 1;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  },
);