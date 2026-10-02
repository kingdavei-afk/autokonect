import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './common/config/config.module';
import { bootstrapEnv } from './common/config/env.loader';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { StructuredLogger } from './common/logger/structured-logger';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';

async function bootstrap(): Promise<void> {
  // Le .env doit etre charge avant NestFactory.create : la validation
  // de la configuration s'execute a l'instanciation des modules.
  bootstrapEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // bufferLogs retient les journaux du framework jusqu'a l'appel de
    // useLogger() ci-dessous. Sans cela, la sortie melange du texte ANSI
    // et du JSON, illisible pour une collecte de logs (CDCS 11.8).
    logger: false,
    bufferLogs: true,
  });

  const config = app.get<AppConfig>(APP_CONFIG);

  // StructuredLogger est transient : il faut resolve() et non get().
  const logger = (await app.resolve(StructuredLogger)).setContext('Bootstrap');
  app.useLogger(logger);

  // ---- en-tetes de securite (CDCS 11.5) ----------------------------
  app.disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'geolocation=(self), camera=()');
    next();
  });

  // ---- identifiant de correlation -----------------------------------
  app.use(new RequestContextMiddleware().use);

  // ---- CORS explicite : jamais de joker en production ---------------
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'idempotency-key'],
    exposedHeaders: ['x-request-id'],
    maxAge: 86_400,
  });

  // ---- format d'erreur unique ----------------------------------------
  app.useGlobalFilters(new AllExceptionsFilter());

  app.set('trust proxy', 1);

  await app.listen(config.port, '0.0.0.0');

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
  const message = (error as Error).message;
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'fatal',
      msg: 'demarrage impossible',
      error: message,
    })}\n`,
  );
  process.exit(1);
});