import { z } from 'zod';

/**
 * Validation de la configuration au demarrage.
 *
 * Principe (CDCS 12.1) : l'application doit REFUSER de demarrer avec une
 * configuration invalide plutot que d'echouer de facon aleatoire en
 * production a 3 h du matin. Un secret manquant est une erreur fatale
 * ici ; il ne doit jamais se transformer en 500 en exploitation.
 */

/**
 * Prefixe des valeurs de developpement livrees dans `.env.example`.
 * Toute configuration portant ce prefixe est refusee en production.
 */
const DEV_SECRET_PREFIX = 'DEV-ONLY';

/**
 * Un secret est une chaine non vide. Les regles conditionnelles
 * (interdit en production, seuil de memoire, origines CORS) sont
 * verifiees dans le `superRefine` du schema objet : c'est le seul
 * endroit ou `NODE_ENV` de la configuration VALIDEE est disponible.
 *
 * Lesevaluated au chargement du module, elles ne verifiersent pas la
 * configuration reellement fournie et laisseraient passer une
 * configuration dangereuse.
 */
const secret = z.string().min(1, 'Secret obligatoire.');

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
    /** Connexions par instance. Reduit a 1 en hebergement a invocations ephemeres. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).optional(),

    REDIS_URL: z.string().url().startsWith('redis://').default('redis://127.0.0.1:6379/0'),

    // ---- Redis partage REST (limitation de debit) --------------------
    // OBLIGATOIRE en production. Le stockage par defaut de
    // `@nestjs/throttler` est une Map en memoire du processus : sur un
    // hebergement a invocations ephemeres (Vercel), le compteur repart
    // de zero a chaque requete et la protection annoncee n'a aucun
    // effet. Un code OTP a six chiffres deviendrait forçable.
    UPSTASH_REDIS_REST_URL: z.string().url().startsWith('https://').optional(),
    UPSTASH_REDIS_REST_TOKEN: secret.optional(),

    // ---- Authentification (CDCS 12.2) ------------------------------
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
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
    const inProduction = env.NODE_ENV === 'production';

    // ---- Secrets de developpement ---------------------------------
    if (inProduction) {
      for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (env[key].startsWith(DEV_SECRET_PREFIX)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              `un secret de developpement (prefixe "${DEV_SECRET_PREFIX}") ne peut ` +
              'pas etre utilise en production (CDCS 12.4)',
          });
        }
      }

      // ---- Argon2 ---------------------------------------------------
      if (env.ARGON2_MEMORY_COST < 19_456) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ARGON2_MEMORY_COST'],
          message:
            'doit valoir au moins 19456 en production : sous ce seuil, le hachage ' +
            'des mots de passe est trop rapide pour resister (CDCS 12.2)',
        });
      }

      // ---- CORS ----------------------------------------------------
      const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim());
      const insecure = origins.filter((o) => o && !o.startsWith('https://'));

      if (insecure.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message:
            `origines non securisees interdites en production (https obligatoire) : ${insecure.join(', ')}`,
        });
      }

      // ---- Stockage partage de la limitation de debit --------------
      // Les deux variables vont de pair : l'une sans l'autre ne permet
      // aucune connexion, et demarrer avec une seule masque le probleme
      // jusqu'a la premiere requete.
      const redisUrl = env.UPSTASH_REDIS_REST_URL;
      const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

      if (!redisUrl || !redisToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UPSTASH_REDIS_REST_URL'],
          message:
            'UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN sont obligatoires ' +
            'en production. Sans stockage partage, la limitation de debit retombe ' +
            'sur la memoire de chaque instance : elle est reinitialisee a chaque ' +
            'invocation, donc INEFFICACE, et le code OTP devient forcable ' +
            '(CDCS 12.4).',
        });
      }
    }

    // ---- Stockage objet -------------------------------------------
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

    // ---- Separation des privileges (CDCS 12.1) --------------------
    if (env.DIRECT_DATABASE_URL && env.DIRECT_DATABASE_URL === env.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          'DATABASE_URL ne doit pas utiliser le role privilegie des migrations ' +
          '(DIRECT_DATABASE_URL) : l application doit disposer des droits minimaux',
      });
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