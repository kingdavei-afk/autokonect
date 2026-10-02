import { Global, Module } from '@nestjs/common';

import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
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
 * Infrastructure transverse : configuration, journalisation et
 * normalisation des erreurs.
 *
 * Ces trois elements sont globaux par nature — ils concernent toutes les
 * routes — et doivent pouvoir etre resolus avant tout module metier
 * (CDCS 12.4).
 */
@Global()
@Module({
  providers: [appConfigProvider, StructuredLogger, AllExceptionsFilter],
  exports: [APP_CONFIG, StructuredLogger, AllExceptionsFilter],
})
export class ConfigModule {}