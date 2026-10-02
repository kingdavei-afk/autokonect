import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql, type MigrationResultSet } from 'kysely';

import type { Db } from './connection.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrateOptions {
  dir?: string;
  /** Journalise chaque etape. */
  logger?: (message: string) => void;
}

/** Lit les migrations du disque, triees par nom. */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const content = await readFile(join(dir, name), 'utf8');
      return {
        name,
        sql: content,
        // Le controle d'empreinte detecte une migration modifiee apres
        // coup : une migration appliquee ne doit jamais changer (CDCS 15.4).
        checksum: createHash('sha256').update(content).digest('hex').slice(0, 16),
      };
    }),
  );
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function appliedMigrations(db: Db): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(db);
  const rows = await sql<{
    name: string;
    checksum: string;
    applied_at: Date;
  }>`SELECT name, checksum, applied_at FROM _migrations ORDER BY name`.execute(db);

  return rows.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  /** Migrations dont le contenu a change depuis leur application. */
  drifted: string[];
}

/**
 * Applique les migrations non encore jouees.
 *
 * Chaque migration est executee dans SA PROPRE transaction : une
 * migration qui echoue ne laisse pas la base a moitie appliquee.
 */
export async function migrate(
  db: Db,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const log = options.logger ?? (() => {});
  const files = await loadMigrations(options.dir);
  const applied = await appliedMigrations(db);
  const appliedByName = new Map(applied.map((row) => [row.name, row]));

  const result: MigrateResult = { applied: [], skipped: [], drifted: [] };

  for (const file of files) {
    const existing = appliedByName.get(file.name);

    if (existing) {
      if (existing.checksum !== file.checksum) {
        result.drifted.push(file.name);
        log(
          `ATTENTION  ${file.name} a ete modifie apres application ` +
            `(empreinte ${existing.checksum} -> ${file.checksum}). ` +
            `Creez une nouvelle migration au lieu de modifier celle-ci.`,
        );
      } else {
        result.skipped.push(file.name);
      }
      continue;
    }

    log(`application  ${file.name}`);
    await db.transaction().execute(async (trx) => {
      await sql.raw(file.sql).execute(trx);
      await sql`
        INSERT INTO _migrations (name, checksum)
        VALUES (${file.name}, ${file.checksum})
      `.execute(trx);
    });
    result.applied.push(file.name);
  }

  return result;
}

/** Supprime et recree le schema public. Usage developpement uniquement. */
export async function reset(db: Db, options: MigrateOptions = {}): Promise<MigrateResult> {
  const log = options.logger ?? (() => {});
  log('suppression du schema public');
  await sql`DROP SCHEMA public CASCADE`.execute(db);
  await sql`CREATE SCHEMA public`.execute(db);

  return migrate(db, options);
}

export interface MigrationStatus {
  name: string;
  applied: boolean;
  appliedAt: Date | null;
  drift: boolean;
}

export async function status(db: Db): Promise<MigrationStatus[]> {
  const files = await loadMigrations();
  const applied = new Map(
    (await appliedMigrations(db)).map((row) => [
      row.name,
      { appliedAt: row.appliedAt, checksum: row.checksum },
    ]),
  );

  return files.map((file) => {
    const existing = applied.get(file.name);
    return {
      name: file.name,
      applied: Boolean(existing),
      appliedAt: existing?.appliedAt ?? null,
      drift: existing ? existing.checksum !== file.checksum : false,
    };
  });
}

export type { MigrationResultSet };