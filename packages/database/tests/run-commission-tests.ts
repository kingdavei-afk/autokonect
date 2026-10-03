/**
 * Runner des tests de commission (migration 0002).
 *
 * Meme approche que `run-schema-tests.ts` : base jetable, migrations
 * appliquees, tests dans une transaction annulee, base supprimee.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const TESTS_FILE = fileURLToPath(new URL('./commission-smoke.sql', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures.sql', import.meta.url));

const PSQL =
  process.env['PSQL_BIN'] ??
  ['C:/Program Files/PostgreSQL/17/bin/psql.exe', 'psql'].find((candidate) => {
    if (candidate === 'psql') return true;
    return existsSync(candidate);
  }) ??
  'psql';

const TEST_DB = 'adkcars_commission_test';

function extractPassword(): string {
  const direct = process.env['DIRECT_DATABASE_URL'];
  if (!direct) return '';
  try {
    return decodeURIComponent(new URL(direct).password);
  } catch {
    return '';
  }
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(PSQL, args, {
      env: { ...process.env, PGPASSWORD: process.env['PGPASSWORD'] ?? extractPassword() },
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
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
  process.stdout.write(`psql        : ${PSQL}\n`);
  process.stdout.write(`base de test: ${TEST_DB}\n\n`);

  const created = await run([
    ...baseArgs(), '-d', 'postgres', '-q',
    '-c', `DROP DATABASE IF EXISTS ${TEST_DB};`,
    '-c', `CREATE DATABASE ${TEST_DB} ENCODING 'UTF8';`,
  ]);
  if (created.code !== 0) {
    process.stderr.write(`ERREUR creation base : ${created.err}\n`);
    return 1;
  }

  try {
    process.stdout.write('application des migrations...\n');
    for (const migration of ['0001_init.sql', '0002_commission-et-reversement.sql']) {
      const applied = await run(
        [...baseArgs(), '-d', TEST_DB, '-q', '-f', `${MIGRATIONS_DIR}${migration}`],
      );
      if (applied.code !== 0) {
        process.stderr.write(`ERREUR migration ${migration} : ${applied.err}\n`);
        return 1;
      }
    }

    // Donnees de reference indispensables aux tests.
    const fixtures = await run([...baseArgs(), '-d', TEST_DB, '-q', '-f', FIXTURES]);
    if (fixtures.code !== 0) {
      process.stderr.write(`ERREUR fixtures : ${fixtures.err}\n`);
      return 1;
    }

    process.stdout.write('execution des tests de commission et tresorerie...\n\n');
    const tests = await run([...baseArgs(), '-d', TEST_DB, '-f', TESTS_FILE]);

    process.stdout.write(tests.out);
    if (tests.err.trim()) process.stdout.write(tests.err);

    if (tests.code !== 0) {
      process.stdout.write(
        '\nECHEC : une regle de commission ou de tresorerie n est pas imposee\n',
      );
      return 1;
    }

    process.stdout.write('\nTous les tests de commission sont passes\n');
    return 0;
  } finally {
    await run([...baseArgs(), '-d', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${TEST_DB};`]);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  },
);