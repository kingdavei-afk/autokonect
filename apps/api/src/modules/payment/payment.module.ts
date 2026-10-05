import { Module } from '@nestjs/common';

import { BookingModule } from '../booking/booking.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentProviderRegistry } from './providers/provider.registry';
import { SimulatorPaymentProvider } from './providers/simulator.provider';

/**
 * Metier du paiement (CDCS 14).
 *
 * ------------------------------------------------------------------------
 * LE SIMULATEUR EST UN ADAPTATEUR DE PRODUCTION
 * ------------------------------------------------------------------------
 * Il porte une vraie signature HMAC, un cycle de vie complet et des
 * notifications retransmises. Ce n'est pas un bouchon pose pour faire
 * passer les tests.
 *
 * Un simulateur « minimal » aurait oblige a choisir entre deux defauts :
 * soit la verification de signature ne serait jamais exercee, soit on
 * ecrirait un chemin de verification que la production n'utilisera pas.
 * Les deux significent que le premier bug de signature sera decouvert en
 * production, sur un paiement reel.
 *
 * L'arbitrage A-02 (prestataire de reference) n'est pas tranche : aucun
 * adaptateur Orange Money, Wave, MTN ou Moov n'existe. Le registre les
 * accueille sans que le service change — c'est ce qui rend A-02 un
 * arbitrage et non une decision de structure.
 *
 * ------------------------------------------------------------------------
 * LA SIGNATURE EST EXIGEE, Y COMPRIS SANS SECRET
 * ------------------------------------------------------------------------
 * Le simulateur refuse de signer si sa cle fait moins de 32
 * caracteres, et `isAvailable()` renvoie alors `false`. Un environnement
 * mal configure ne peut donc pas se comporter comme un environnement de
 * test qui laisse passer : il refuse d'ouvrir des paiements.
 */
@Module({
  imports: [BookingModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentProviderRegistry,
    {
      provide: 'PAYMENT_PROVIDERS',
      inject: [SimulatorPaymentProvider],
      useFactory: (simulator: SimulatorPaymentProvider): SimulatorPaymentProvider[] => [
        simulator,
      ],
    },
    {
      provide: SimulatorPaymentProvider,
      useFactory: (): SimulatorPaymentProvider =>
        new SimulatorPaymentProvider({
          secret: process.env['PAYMENT_PROVIDER_SECRET'] ?? '',
          toleranceSeconds: Number(process.env['PAYMENT_WEBHOOK_TOLERANCE_SECONDS'] ?? '300'),
          unavailable: process.env['PAYMENT_PROVIDER_UNAVAILABLE'] === 'true',
        }),
    },
  ],
  exports: [PaymentService, PaymentProviderRegistry],
})
export class PaymentModule {}

