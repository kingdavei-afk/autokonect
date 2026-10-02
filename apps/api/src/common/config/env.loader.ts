import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadEnvFile } from 'dotenv';

/**
 * Charge le fichier .env AVANT toute lecture de `process.env`.
 *
 * En developpement, le fichier est a la racine du monorepo alors que le
 * service s'execute depuis `apps/api` : on remonte donc l'arborescence
 * jusqu'a trouver un `.env`. En production, aucun fichier n'est lu : les
 * variables proviennent de l'environnement du conteneur ou du coffre
 * de secrets (CDCS 12.4).
 */
export function bootstrapEnv(): void {
  if (process.env['NODE_ENV'] === 'production') return;

  const startDir = process.cwd();
  const candidates = [
    join(startDir, '.env'),
    join(dirname(startDir), '.env'),
    join(dirname(dirname(startDir)), '.env'),
    resolve(startDir, '../../.env'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadEnvFile({ path: candidate });
      return;
    }
  }

  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: 'aucun fichier .env trouve, configuration issue du seul environnement',
    })}\n`,
  );
}