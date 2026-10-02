/**
 * Runner des tests de schema (CDCS 16.2).
 *
 * La base de test est un clone jetable : on applique la migration, on
 * execute le fichier de tests dans une transaction annulee, puis on
 * supprime la base. Aucune donnee de developpement n'est touchee.
 *
 * Le fichier de tests reste un script psql : c'est le seul outil qui
 * execute nativement les commandes `\echo` et `\set`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TESTS_FILE = fileURLToPath(new URL('./schema-smoke.sql', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const PSQL =
  process.env['PSQL_BIN'] ??
  ['C:/Program Files/PostgreSQL/17/bin/psql.exe', 'psql'].find((candidate) => {
    if (candidate === 'psql') return true;
    return existsSync(candidate);
  }) ??
  'psql';

const TEST_DB = 'adkcars_schema_test';
const MIGRATION_FILE = `${MIGRATIONS_DIR}0001_init.sql`;

function run(
  args: string[],
  database: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(PSQL, args, {
      env: {
        ...process.env,
        PGPASSWORD: process.env['PGPASSWORD'] ?? extractPassword(),
      },
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function extractPassword(): string {
  const direct = process.env['DIRECT_DATABASE_URL'];
  if (!direct) return '';
  try {
    return decodeURIComponent(new URL(direct).password);
  } catch {
    return '';
  }
}

function baseArgs(): string[] {
  const direct = new URL(process.env['DIRECT_DATABASE_URL'] ?? '');
  return [
    '-U',
    decodeURIComponent(direct.username || 'postgres'),
    '-h',
    direct.hostname || '127.0.0.1',
    '-p',
    direct.port || '5432',
    '-v',
    'ON_ERROR_STOP=1',
  ];
}

async function main(): Promise<number> {
  process.stdout.write(`psql utilise : ${PSQL}\n`);
  process.stdout.write(`base de test : ${TEST_DB}\n\n`);

  // 1. base jetable
  let result = await run(
    [...baseArgs(), '-d', 'postgres', '-q', '-c',
     `DROP DATABASE IF EXISTS ${TEST_DB};`, '-c',
     `CREATE DATABASE ${TEST_DB} ENCODING 'UTF8';`],
    'postgres',
  );
  if (result.code !== 0) {
    process.stderr.write(`ERREUR creation base : ${result.err}\n`);
    return 1;
  }

  try {
    // 2. application de la migration
    process.stdout.write('application de la migration...\n');
    result = await run([...baseArgs(), '-d', TEST_DB, '-q', '-f', MIGRATION_FILE], TEST_DB);
    if (result.code !== 0) {
      process.stderr.write(`ERREUR migration : ${result.err}\n`);
      return 1;
    }

    // 3. tests
    process.stdout.write('execution des tests de regle metier...\n\n');
    result = await run([...baseArgs(), '-d', TEST_DB, '-f', TESTS_FILE], TEST_DB);

    process.stdout.write(result.out);
    if (result.err.trim()) process.stdout.write(result.err);

    if (result.code !== 0) {
      process.stdout.write('\nECHEC : au moins une regle metier n est pas imposee\n');
      return 1;
    }

    process.stdout.write('\nTous les tests de schema sont passes\n');
    return 0;
  } finally {
    await run(
      [...baseArgs(), '-d', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${TEST_DB};`],
      'postgres',
    );
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  },
);