import { z } from 'zod';

/**
 * Validation de la configuration au demarrage.
 *
 * Principe (CDCS 12.1) : l'application doit REFUSER de demarrer avec une
 * configuration invalide plutot que d'echouer de facon aleatoire en
 * production a 3 h du matin. Un secret manquant est une erreur fatale
 * ici ; il ne doit jamais se transformer en 500 en exploitation.
 */

const isProduction = process.env['NODE_ENV'] === 'production';

/** Secrets de developpement : acceptes uniquement hors production. */
const devSecret = z
  .string()
  .min(1)
  .refine((value) => !isProduction || !value.startsWith('DEV-ONLY'), {
    message:
      'Un secret de developpement ne peut pas etre utilise en production (CDCS 12.4)',
  });

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

    APP_NAME: z.string().default('@adkcars/api'),
    APP_VERSION: z.string().default('0.1.0'),
    LOG_LEVEL: z
      .enum(['error', 'warn', 'info', 'debug', 'verbose'])
      .default('info'),
    LOG_PREFIX: z.string().default('[api]'),

    // ---- Base de donnees -------------------------------------------
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    /** Role privilegie, reserve aux migrations. Ne doit pas etre utilise par l'API. */
    DIRECT_DATABASE_URL: z.string().url().startsWith('postgresql://').optional(),

    REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379/0'),

    // ---- Authentification (CDCS 12.2) ------------------------------
    JWT_ACCESS_SECRET: devSecret,
    JWT_REFRESH_SECRET: devSecret,
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    ARGON2_MEMORY_COST: z.coerce.number().int().min(8_192).max(262_144).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(1).max(16).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

    // ---- Verification de telephone ---------------------------------
    OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    SMS_PROVIDER: z.enum(['mock', 'twilio', 'africastalking']).default('mock'),

    // ---- Stockage objet (CDCS 14.4) --------------------------------
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./var/storage'),
    STORAGE_BUCKET: z.string().optional(),
    STORAGE_REGION: z.string().optional(),
    STORAGE_ENDPOINT: z.string().optional(),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

    // ---- Reseau ----------------------------------------------------
    CORS_ORIGINS: z.string().default('http://localhost:3001'),

    // ---- Observabilite (CDCS 11.8) ---------------------------------
    SENTRY_DSN: z.string().optional(),
    OTEL_ENABLED: z.coerce.boolean().default(false),

    // ---- Limitation de debit (CDCS 12.4) ---------------------------
    THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
    THROTTLE_LIMIT_SHORT: z.coerce.number().int().min(1).default(20),
    THROTTLE_LIMIT_MEDIUM: z.coerce.number().int().min(1).default(100),
  })
  .superRefine((env, ctx) => {
    // En production, la memoire Argon2 doit etre serieusement calibree.
    if (env.NODE_ENV === 'production' && env.ARGON2_MEMORY_COST < 19_456) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ARGON2_MEMORY_COST'],
        message:
          'ARGON2_MEMORY_COST doit valoir au moins 19456 en production (CDCS 12.2)',
      });
    }

    if (env.NODE_ENV === 'production' && !env.CORS_ORIGINS.includes('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS doit designer des origines https en production',
      });
    }

    if (env.STORAGE_DRIVER === 's3') {
      const required = [
        'STORAGE_BUCKET',
        'STORAGE_ACCESS_KEY_ID',
        'STORAGE_SECRET_ACCESS_KEY',
      ] as const;
      for (const key of required) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} est obligatoire quand STORAGE_DRIVER=s3`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  port: number;
  app: { name: string; version: string };
  log: { level: Env['LOG_LEVEL']; prefix: string };
  corsOrigins: string[];
}

/**
 * Analyse et valide les variables d'environnement.
 * Leve une erreur lisible listant TOUS les problemes rencontres.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(racine)'}: ${issue.message}`,
    );
    throw new Error(
      `Configuration invalide, demarrage refuse :\n${lines.join('\n')}\n\n` +
        `Verifiez le fichier .env (modele : .env.example).`,
    );
  }

  const env = parsed.data;

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    app: { name: env.APP_NAME, version: env.APP_VERSION },
    log: { level: env.LOG_LEVEL, prefix: env.LOG_PREFIX },
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}