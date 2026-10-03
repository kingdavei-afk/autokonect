import { Global, Inject, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { APP_CONFIG, type AppConfig } from '../../common/config/config.module';
import { StructuredLogger } from '../../common/logger/structured-logger';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * ------------------------------------------------------------------------
 * Stockage du limiteur de debit
 * ------------------------------------------------------------------------
 * Ce module existe pour une raison technique precise, et non par
 * commodite.
 *
 * `ThrottlerModule.forRootAsync()` cree son PROPRE conteneur
 * d'injection. Un provider declare dans `AppModule` n'y est pas
 * visible : la resolution echoue avec « Nest can't resolve
 * dependencies of the THROTTLER:MODULE_OPTIONS ».
 *
 * Il faut donc que le stockage soit declare dans un module que
 * `forRootAsync` importe explicitement.
 *
 * ------------------------------------------------------------------------
 * LE STOCKAGE PAR DEFAUT NE VAUT PAS EN PRODUCTION
 * ------------------------------------------------------------------------
 * Le stockage par defaut de `@nestjs/throttler` est une `Map` en
 * memoire du processus. Sur un hebergement a invocations ephemeres
 * (Vercel, A-18), chaque instance repart de zero : la limite annoncee
 * n'a aucun effet et le code OTP devient forcable.
 *
 * C'est une panne SILENCIEUSE — aucun test ne la detecte, aucune
 * alerte ne se declenche. D'ou deux mesures plutot qu'une :
 *   1. ici, le stockage partage quand Redis est configure ;
 *   2. dans `env.validation.ts`, le refus de demarrer en production
 *      sans Redis, plutot que de tourner sans protection.
 * ------------------------------------------------------------------------
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerConfigModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [
          {
            name: 'short',
            ttl: Number(process.env['THROTTLE_TTL_SECONDS'] ?? 60) * 1_000,
            limit: Number(process.env['THROTTLE_LIMIT_SHORT'] ?? 20),
          },
          {
            name: 'medium',
            // La limite moyenne s'etalle sur l'heure, mais sa fenetre
            // de depart suit le meme declencheur : sans cela, elle
            // derivait de l'heure de premiere requete et le compteur
            // pouvait expirer avant la fin de la periode attendue.
            ttl: Number(process.env['THROTTLE_TTL_SECONDS'] ?? 60) * 60_000,
            limit: Number(process.env['THROTTLE_LIMIT_MEDIUM'] ?? 100),
          },
        ],
        // `undefined` fait revenir `@nestjs/throttler` sur son stockage
        // en memoire : acceptable en developpement, interdit en
        // production (voir env.validation.ts).
        storage,
      }),
    }),
  ],
  providers: [
    {
      provide: RedisThrottlerStorage,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RedisThrottlerStorage | undefined => {
        if (!RedisThrottlerStorage.isConfigured()) {
          // En production, `env.validation.ts` a deja refuse de
          // demarrer. Ce message ne concerne donc que le
          // developpement, ou l'on accepte sciemment la limite : une
          // instance unique y rend le stockage en memoire correct.
          new StructuredLogger(config)
            .setContext('Throttler')
            .warn(
              'Redis absent : la limitation de debit repose sur la memoire du ' +
                'processus. Correct en developpement (instance unique), INEFFICACE ' +
                'en hebergement a invocations ephemeres ou chaque invocation ' +
                'repart de zero.',
            );

          return undefined;
        }

        return new RedisThrottlerStorage(
          process.env['UPSTASH_REDIS_REST_URL']!,
          process.env['UPSTASH_REDIS_REST_TOKEN']!,
          new StructuredLogger(config).setContext('Throttler'),
        );
      },
    },
  ],
  exports: [ThrottlerModule, RedisThrottlerStorage],
})
export class ThrottlerConfigModule {}
