import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { PaymentMethod, PaymentProvider } from '@adkcars/contracts';

/**
 * Registre des prestataires de paiement.
 *
 * ------------------------------------------------------------------------
 * POURQUOI UN REGISTRE ET NON UN SINGLETON
 * ------------------------------------------------------------------------
 * L'arbitrage A-02 (prestataire de reference) n'est pas tranche. Aucun
 * adaptateur Orange Money, Wave, MTN ou Moov n'existe.
 *
 * Un module ecrit autour d'un prestataire unique aurait fait de ce choix
 * une decision de structure : le remplacer supposerait de reecrire le
 * service. Le registre permet d'enregistrer un adaptateur de plus sans
 * toucher au service — et donc de traiter A-02 comme ce qu'il est, un
 * arbitrage, plutot qu'un fait.
 *
 * ------------------------------------------------------------------------
 * LA RESOLUTION EST STRICTE
 * ------------------------------------------------------------------------
 * Une notification dont on ignore le prestataire n'est PAS traitee. La
 * traiter « au hasard » reviendrait a accepter une requete dont personne
 * ne revendique la signature. Une URL de webhook qui n'existe pas doit
 * repondre 404 et non 200 : repondre 200 ferait croire au prestataire
 * que sa notification est enregistree, et il arreterait de la renvoyer.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(@Inject('PAYMENT_PROVIDERS') providers: readonly PaymentProvider[]) {
    for (const provider of providers) {
      this.providers.set(provider.key, provider);
      this.logger.log(
        `prestataire ${provider.key} (${provider.label}) — moyens : ${provider.methods.join(', ')}`,
      );
    }
  }

  /** Prestataire connu sous cette cle. 404 sinon — jamais de defaut. */
  resolve(key: string): PaymentProvider {
    const provider = this.providers.get(key);

    if (!provider) {
      throw new NotFoundException({
        code: 'PROVIDER_UNKNOWN',
        message: `Prestataire de paiement inconnu : ${key}.`,
        details: { available: [...this.providers.keys()] },
      });
    }

    return provider;
  }

  /** Prestataires proposant ce moyen de paiement, dans l'ordre de declaration. */
  forMethod(method: PaymentMethod): PaymentProvider[] {
    return [...this.providers.values()].filter((provider) =>
      provider.methods.includes(method),
    );
  }

  /** Prestataires joignables pour ce moyen. */
  async availableFor(method: PaymentMethod): Promise<PaymentProvider[]> {
    const candidats = this.forMethod(method);
    const joignables: PaymentProvider[] = [];

    for (const provider of candidats) {
      if (await provider.isAvailable()) {
        joignables.push(provider);
      }
    }

    return joignables;
  }

  keys(): string[] {
    return [...this.providers.keys()];
  }
}
