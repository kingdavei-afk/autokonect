/**
 * Runner des tests financiers (migrations 0002, 0005, 0007, 0008).
 *
 * Le nom dit « commission » alors qu il porte aussi les paiements
 * directs, les creances, les politiques financieres et la machine a
 * etats du paiement. Le renommage reste a faire : il ne doit pas
 * retarder la couverture, mais il ne doit pas non plus donner
 * l impression que le fichier couvre moins que son contenu.
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
const DIRECT_TESTS_FILE = fileURLToPath(
  new URL('./direct-payments-smoke.sql', import.meta.url),
);
const POLICY_TESTS_FILE = fileURLToPath(
  new URL('./politiques-smoke.sql', import.meta.url),
);
const PAYMENT_TESTS_FILE = fileURLToPath(
  new URL('./paiement-machine-smoke.sql', import.meta.url),
);
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures.sql', import.meta.url));

const PSQL =
  process.env['PSQL_BIN'] ??
  ['C:/Program Files/PostgreSQL/17/bin/psql.exe', 'psql'].find((candidate) => {
    if (candidate === 'psql') return true;
    return existsSync(candidate);
  }) ??
  'psql';

/**
 * Nom de la base jetable.
 *
 * Surchargeable par `ADKCARS_TEST_DB`, sans quoi deux executions en
 * parallele — cas courant en integration continue — se disputeraient le
 * meme schema. L'echec qui en resulted ne correspondrait a aucun defaut
 * du code, et bloquerait l'acces a une erreur qui n'existe pas.
 *
 * En developpement, la variable est absente et le nom fixe suffit : une
 * seule suite tourne a la fois sur la machine.
 */
const TEST_DB = process.env['ADKCARS_TEST_DB'] ?? 'adkcars_commission_test';

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
    for (const migration of [
    '0001_init.sql',
    '0002_commission-et-reversement.sql',
    '0003-suppression-tva.sql',
    '0004-privileges-application.sql',
    '0005-paiements-directs-et-creances.sql',
    '0006-donnees-reference.sql',
  '0007-politiques-financieres.sql',
  '0008-machine-etats-paiement.sql',
  ]) {
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

    // Circuit direct et creances (A-20). Meme base, meme transaction :
    // ces tests completent les precedents, ils ne repartent pas de zero.
    process.stdout.write('\nexecution des tests de paiements directs...\n\n');
    const direct = await run([...baseArgs(), '-d', TEST_DB, '-f', DIRECT_TESTS_FILE]);

    process.stdout.write(direct.out);
    if (direct.err.trim()) process.stdout.write(direct.err);

    if (direct.code !== 0) {
      process.stdout.write(
        '\nECHEC : la separation des circuits financiers n est pas imposee\n',
      );
      return 1;
    }

    // Politiques financieres (CDCS 4.6, migration 0007).
    process.stdout.write('\nexecution des tests de politiques financieres...\n\n');
    const policies = await run([
      ...baseArgs(), '-d', TEST_DB, '-f', POLICY_TESTS_FILE,
    ]);

    process.stdout.write(policies.out);
    if (policies.err.trim()) process.stdout.write(policies.err);

    if (policies.code !== 0) {
      process.stdout.write(
        '\nECHEC : une politique financiere n est pas imposee\n',
      );
      return 1;
    }

    // Machine a etats du paiement (migration 0008).
    process.stdout.write('\nexecution des tests de la machine a etats du paiement...\n\n');
    const paymentMachine = await run([
      ...baseArgs(), '-d', TEST_DB, '-f', PAYMENT_TESTS_FILE,
    ]);

    process.stdout.write(paymentMachine.out);
    if (paymentMachine.err.trim()) process.stdout.write(paymentMachine.err);

    if (paymentMachine.code !== 0) {
      process.stdout.write(
        '\nECHEC : une regle de la machine a etats du paiement n est pas imposee\n',
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