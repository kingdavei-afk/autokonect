import { describe, expect, it } from 'vitest';

import { loadConfig } from './env.validation';

/**
 * These tests verifient une exigence de disponibilite, pas un detail
 * d'implémentation : une configuration invalide doit EMPECHER le
 * demarrage du service. C'est la difference entre une panne detectee au
 * deploiement et une panne decouverte en production a 3 h du matin
 * (CDCS 12.1).
 */

/** Configuration minimale de reference. */
const baseEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'secret-de-test-suffisamment-long-pour-hs256',
  JWT_REFRESH_SECRET: 'autre-secret-de-test-suffisamment-long-pour-hs256',
  ...overrides,
});

describe('loadConfig', () => {
  it('accepte une configuration minimale valide', () => {
    const config = loadConfig(baseEnv());

    expect(config.env).toBe('test');
    expect(config.port).toBe(3000);
    expect(config.corsOrigins).toEqual(['http://localhost:3001']);
  });

  it('refuse de demarrer sans DATABASE_URL', () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>)['DATABASE_URL'];

    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('refuse un DATABASE_URL qui n est pas une URL postgresql', () => {
    expect(() =>
      loadConfig(baseEnv({ DATABASE_URL: 'mysql://user:pass@localhost/db' })),
    ).toThrow(/DATABASE_URL/);
  });

  it('refuse de demarrer sans secret JWT', () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>)['JWT_ACCESS_SECRET'];

    expect(() => loadConfig(env)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('liste TOUTES les erreurs en une seule fois', () => {
    // Un demarrage qui signale une erreur a la fois impose de
    // redemarrer le service N fois pour corriger N variables.
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/JWT_REFRESH_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('refuse un secret de developpement en production', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'DEV-ONLY-access-secret',
        }),
      ),
    ).toThrow(/developpement/i);
  });

  it('refuse des origines CORS non securisees en production', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'http://localhost:3001',
        }),
      ),
    ).toThrow(/https/i);
  });

  it('refuse une memoire Argon2 sous le seuil en production', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          ARGON2_MEMORY_COST: '8192',
        }),
      ),
    ).toThrow(/ARGON2_MEMORY_COST/);
  });

  it('exige les identifiants de stockage quand le pilote est s3', () => {
    expect(() => loadConfig(baseEnv({ STORAGE_DRIVER: 's3' }))).toThrow(/STORAGE_BUCKET/);
  });

  it('accepte s3 avec les identifiants fournis', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          STORAGE_DRIVER: 's3',
          STORAGE_BUCKET: 'adkcars-media',
          STORAGE_ACCESS_KEY_ID: 'cle',
          STORAGE_SECRET_ACCESS_KEY: 'secret',
        }),
      ),
    ).not.toThrow();
  });

  it('convertit les variables numeriques', () => {
    const config = loadConfig(baseEnv({ PORT: '8080', OTP_MAX_ATTEMPTS: '5' }));

    expect(config.port).toBe(8080);
    expect(config.port).not.toBe('8080');
  });

  it('decoupe la liste des origines CORS', () => {
    const config = loadConfig(
      baseEnv({ CORS_ORIGINS: 'https://a.ci, https://b.ci ,' }),
    );

    expect(config.corsOrigins).toEqual(['https://a.ci', 'https://b.ci']);
  });

  it('refuse que l application utilise le role privilegie des migrations', () => {
    const url = 'postgresql://postgres:secret@localhost:5432/db';

    expect(() =>
      loadConfig(baseEnv({ DATABASE_URL: url, DIRECT_DATABASE_URL: url })),
    ).toThrow(/DATABASE_URL/);
  });
});