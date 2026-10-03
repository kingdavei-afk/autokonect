import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { configureApp, NEST_FACTORY_OPTIONS } from './bootstrap/configure-app';
import { bootstrapEnv } from './common/config/env.loader';
import { StructuredLogger } from './common/logger/structured-logger';

/**
 * Point d'entree serveur autonome.
 *
 * Utilise pour le developpement local, les tests de bout en bout et tout
 * hebergement a processus persistant. En hebergement a invocations
 * ephemeres (Vercel), le point d'entree est
 * `src/bootstrap/vercel-handler.ts`, qui reutilise `configureApp` : les
 * deux produisent exactement la meme application.
 */
async function bootstrap(): Promise<void> {
  // Le .env doit etre charge avant NestFactory.create : la validation
  // de la configuration s'execute a l'instanciation des modules.
  bootstrapEnv();

  // `abortOnError: false` : sans lui, Nest quitte sur `process.exit(1)`
  // sans imprimer la cause. Voir le commentaire dans configure-app.ts.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    NEST_FACTORY_OPTIONS,
  );

  const config = await configureApp(app);

  await app.listen(config.port, '0.0.0.0');

  const logger = (await app.resolve(StructuredLogger)).setContext('Bootstrap');
  logger.log('service demarre', {
    port: config.port,
    environment: config.env,
    version: config.app.version,
  });

  // Arret propre : laisse Nest fermer le pool de connexions.
  const shutdown = async (signal: string): Promise<void> => {
    logger.log('arret du service en cours', { signal });
    await app.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

bootstrap().catch((error: unknown) => {
  const err = error as Error;
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'fatal',
      msg: 'demarrage impossible',
      error: err.message,
      // La pile n'est utile qu'en developpement ; en production elle
      // pollue les journaux sans rien ajouter au message.
      stack: process.env['NODE_ENV'] === 'production' ? undefined : err.stack,
    })}\n`,
  );
  process.exit(1);
});
