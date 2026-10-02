import { Global, Module } from '@nestjs/common';

import { StructuredLogger } from '../logger/structured-logger';
import { APP_CONFIG } from '../tokens';
import { loadConfig, type AppConfig } from './env.validation';

export { APP_CONFIG } from '../tokens';
export type { AppConfig, Env } from './env.validation';

export const appConfigProvider = {
  provide: APP_CONFIG,
  useFactory: (): AppConfig => loadConfig(),
};

/**
 * La configuration validee est figee au demarrage. Aucun module ne lit
 * `process.env` directement : cela rendrait la configuration impossible a
 * tester et les secrets impossibles a tracer.
 */
@Global()
@Module({
  providers: [appConfigProvider, StructuredLogger],
  exports: [APP_CONFIG, StructuredLogger],
})
export class ConfigModule {}