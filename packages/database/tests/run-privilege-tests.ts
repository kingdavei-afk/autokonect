/**
 * Execution des tests de privileges (CDCS 12.1).
 *
 * Ces tests se distinguent des autres par un point : ils ne peuvent pas
 * s'executer en superuser.
 *
 * Verifier qu'un privilege est REFUSE exige de tenter l'operation avec
 * le role qui n'a pas le privilege. Le role de migration a tous les
 * droits : lui, il constaterait toujours un succes, et le test
 * passerait sans avoir rien prouve. C'est ce qui rend une suite de
 * tests de privileges inutile si elle tourne avec le mauvais role.
 *
 * La suite s'execute donc dans une base jetable, via le compte
 * applicatif, avec le role de droits `adkcars_app` pour le contrat
 * lui-meme.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Le .env est a la racine du monorepo alors que le runner vit dans le
// package : sans ce chargement, `DIRECT_DATABASE_URL` est absente et le
// message d'erreur est « Invalid URL », qui ne dit rien du vrai
// probleme.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const TESTS_FILE = fileURLToPath(new URL('./privileges-smoke.sql', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Migrations appliquees, dans l'ordre. */
const MIGRATIONS = [
  '0001_init.sql',
  '0002_commission-et-reversement.sql',
  '0003-suppression-tva.sql',
  '0004-privileges-application.sql',
  '0005-paiements-directs-et-creances.sql',
  '0006-donnees-reference.sql',
];

const PSQL =
  process.env['PSQL_BIN'] ??
  ['C:/Program Files/PostgreSQL/17/bin/psql.exe', 'psql'].find((candidate) =>
    candidate === 'psql' ? true : existsSync(candidate),
  ) ??
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
const TEST_DB = process.env['ADKCARS_TEST_DB'] ?? 'adkcars_privileges_test';

/** Compte applicatif, celui qu'utilise `DATABASE_URL`. */
const APP_ROLE = 'adkcars';
const APP_PASSWORD = 'adkcars_dev';

interface PsqlResult {
  code: number;
  out: string;
  err: string;
}

function run(args: string[], password?: string): Promise<PsqlResult> {
  return new Promise((resolve) => {
    const child = spawn(PSQL, args, {
      env: { ...process.env, PGPASSWORD: password ?? process.env['PGPASSWORD'] ?? '' },
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

/** Arguments de connexion du role de migration, tire de DIRECT_DATABASE_URL. */
function migrationArgs(): string[] {
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

/**
 * Mot de passe du role de migration.
 *
 * Il est LU dans `DIRECT_DATABASE_URL`, jamais repris de `PGPASSWORD`.
 * Reprendre la variable d'environnement ne fonctionne que si elle a ete
 * definie par l'appelant ; sinon elle est vide, `psql` demande le mot de
 * passe sur l'entree standard, et le runner attend indefiniment sans
 * message. C'est un blocage muet, pas une erreur : rien n'indique
 * qu'il faut un mot de passe.
 */
function migrationPassword(): string {
  const fromEnv = process.env['PGPASSWORD'];

  if (fromEnv) return fromEnv;

  try {
    return decodeURIComponent(new URL(process.env['DIRECT_DATABASE_URL'] ?? '').password);
  } catch {
    return '';
  }
}

async function main(): Promise<number> {
  process.stdout.write(`psql utilise : ${PSQL}\n`);
  process.stdout.write(`base de test : ${TEST_DB}\n`);
  process.stdout.write(`role applicatif : ${APP_ROLE}\n\n`);

  // 1. Base jetable, proprietaire du role de migration.
  //
  // `OWNER` explicite : si la base appartenait au role applicatif, il
  // hériterait de `pg_database_owner` et pourrait creer des tables.
  // Les tests P3 et P4 echoueraient alors pour une raison qui n'a rien
  // a voir avec les privileges testes.
  let result = await run(
    [
      ...migrationArgs(),
      '-d',
      'postgres',
      '-q',
      '-c',
      `DROP DATABASE IF EXISTS ${TEST_DB};`,
      '-c',
      `CREATE DATABASE ${TEST_DB} OWNER ${decodeURIComponent(
        new URL(process.env['DIRECT_DATABASE_URL'] ?? '').username || 'postgres',
      )} ENCODING 'UTF8';`,
    ],
    migrationPassword());

  if (result.code !== 0) {
    process.stderr.write(`ERREUR creation base : ${result.err}\n`);
    return 1;
  }

  try {
    // 2. Le schema public doit etre neutralize comme en developpement,
    //    sinon PUBLIC y conserve CREATE et tous les tests de refus
    //    echoueraient pour une raison accidentelle.
    result = await run(
      [
        ...migrationArgs(),
        '-d',
        TEST_DB,
        '-q',
        '-c',
        'ALTER SCHEMA public OWNER TO ' +
          decodeURIComponent(new URL(process.env['DIRECT_DATABASE_URL'] ?? '').username || 'postgres') +
          '; REVOKE ALL ON SCHEMA public FROM PUBLIC;',
      ],
      migrationPassword());

    if (result.code !== 0) {
      process.stderr.write(`ERREUR neutralisation du schema : ${result.err}\n`);
      return 1;
    }

    // 3. Migrations, avec le role de migration.
    process.stdout.write('application des migrations...\n');

    for (const migration of MIGRATIONS) {
      result = await run(
        [...migrationArgs(), '-d', TEST_DB, '-q', '-f', `${MIGRATIONS_DIR}${migration}`],
        migrationPassword());

      if (result.code !== 0) {
        process.stderr.write(`ERREUR migration ${migration} : ${result.err}\n`);
        return 1;
      }
    }

    // 4. Le compte applicatif doit adherer au role de droits, exactement
    //    comme le fait le provisionnement de developpement.
    result = await run(
      [...migrationArgs(), '-d', TEST_DB, '-q', '-c', `GRANT adkcars_app TO ${APP_ROLE};`],
      migrationPassword());

    if (result.code !== 0) {
      process.stderr.write(`ERREUR adhesion au role de droits : ${result.err}\n`);
      return 1;
    }

    // 5. Les tests, avec le COMPTE APPLICATIF.
    process.stdout.write('execution des tests de privileges...\n\n');

    result = await run(
      [
        '-U',
        APP_ROLE,
        '-h',
        new URL(process.env['DIRECT_DATABASE_URL'] ?? '').hostname || '127.0.0.1',
        '-p',
        new URL(process.env['DIRECT_DATABASE_URL'] ?? '').port || '5432',
        '-v',
        'ON_ERROR_STOP=1',
        '-d',
        TEST_DB,
        '-f',
        TESTS_FILE,
      ],
      APP_PASSWORD,
    );

    process.stdout.write(result.out);
    if (result.err.trim()) process.stdout.write(result.err);

    if (result.code !== 0) {
      process.stdout.write(
        '\nECHEC : le contrat de privileges du role applicatif n est pas respecte\n',
      );
      return 1;
    }

    process.stdout.write('\nTous les tests de privileges sont passes\n');
    return 0;
  } finally {
    await run(
      [...migrationArgs(), '-d', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${TEST_DB};`],
      migrationPassword());
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`ERREUR : ${(error as Error).message}\n`);
    process.exit(1);
  },
);
