import { Inject, Injectable, type LoggerService } from '@nestjs/common';

import { SMS_PROVIDER, type SmsMessage, type SmsSendResult } from './sms.provider';

/**
 * Fournisseur de SMS de developpement.
 *
 * Aucun SMS n'est envoye : le contenu est journalise et le code OTP est
 * ecrit dans le journal du fournisseur. C'est ce qui permet de
 * developper et de tester le parcours de verification sans cout ni
 * dependance a un operateur.
 *
 * DANGER : ce fournisseur ne doit jamais etre actif ailleurs qu'en
 * developpement ou en test. `SmsModule` leve une erreur au demarrage
 * si `SMS_PROVIDER=mock` alors que `NODE_ENV=production`.
 */
@Injectable()
export class MockSmsProvider {
  private readonly sent: SmsMessage[] = [];

  constructor(@Inject('LoggerSms') private readonly logger: LoggerService) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push(message);

    this.logger.warn(
      `SMS simule vers ${maskPhone(message.to)} : ${message.body}`,
    );

    return {
      accepted: true,
      externalRef: `mock-${this.sent.length}`,
      cost: 0,
    };
  }

  /** Messages emis pendant la session : utilise par les tests. */
  get outbox(): readonly SmsMessage[] {
    return this.sent;
  }
}

/** Masque un numero : 4 derniers chiffres seulement. */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}