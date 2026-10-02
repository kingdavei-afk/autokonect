import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../common/config/config.module';
import { StructuredLogger } from '../../common/logger/structured-logger';
import { MockSmsProvider } from './sms/mock-sms.provider';
import { SMS_PROVIDER } from './sms/sms.provider';

/** Logger deja contexte sur le canal SMS. */
export const LOGGER_SMS = 'LoggerSms';

/**
 * Fournisseur de notifications.
 *
 * Seule l'implementation de developpement est presente a ce stade. Les
 * adaptateurs reels seront ajoutes en phase P2, chacun avec son propre
 * contrat marchand (CDCS 14.1).
 */
@Global()
@Module({
  providers: [
    {
      provide: LOGGER_SMS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new StructuredLogger(config).setContext('Sms'),
    },
    MockSmsProvider,
    { provide: SMS_PROVIDER, useExisting: MockSmsProvider },
  ],
  exports: [SMS_PROVIDER, LOGGER_SMS],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SMS_PROVIDER) private readonly sms: MockSmsProvider,
  ) {}

  onModuleInit(): void {
    const provider = process.env['SMS_PROVIDER'] ?? 'mock';

    if (this.config.env === 'production' && provider === 'mock') {
      throw new Error(
        'SMS_PROVIDER=mock est interdit en production : aucun code OTP ne serait ' +
          'envoye et aucune reservation ne pourrait etre confirmee (CDCS 14.5).',
      );
    }
  }
}