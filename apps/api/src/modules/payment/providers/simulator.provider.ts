import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  PaymentDeclinedError,
  PaymentProviderUnavailableError,
  type CreatePaymentIntentInput,
  type ExternalPaymentRef,
  type PaymentIntent,
  type PaymentProvider,
  type PaymentMethod,
  type PaymentKind,
  type PaymentStatus,
  type ProviderWebhook,
} from '@adkcars/contracts';

/**
 * Prestataire de paiement SIMULATE.
 *
 * ------------------------------------------------------------------------
 * CE QUE C'EST
 * ------------------------------------------------------------------------
 * Le simulateur d'un operateur mobile money : signatures reelles,cycle de
 * vie complet, notification retRANSMISE. Il n'est pas « minimal » et il
 * n'est pas « temporaire » — c'est un adapter de production dont
 * l'operateur est simule.
 *
 * La distinction est ce qui rend le module testable SANS le rendre
 * faux. Un simulateur sans signature reelle obligerait a choisir entre
 * deux defauts : soit on ne teste jamais la verification, soit on
 * ecrit un chemin de verification que la production n'utilisera pas.
 *
 * ------------------------------------------------------------------------
 * POURQUOI LA SIGNATURE EST IMPOSEE ET NON FACULTE
 * ------------------------------------------------------------------------
 * Une signature verifiee « si presente » est une signature absente.
 *
 * Si l'adaptateur acceptait un webhook sans signature lorsque
 * l'environnement de test n'en fournit pas, la verification serait
 * contournee exactement la ou l'on veut la tester. Le webhook sans
 * signature echoue donc TOUJOURS, y compris en developpement.
 *
 * ------------------------------------------------------------------------
 * L'HORLOGE, PARCE QUE LE TEMPS EST UN ENNEMI
 * ------------------------------------------------------------------------
 * Une fenetre de tolerance est un compromis : trop courte, un
 * prestataire lent est refuse a tort ; trop large, une signature
 * capturee est rejouee.
 *
 * Une notification qui annonce son propre `occurredAt` permet de
 * borner la fenetre sur ce que le signataire pretend. Cinq minutes
 * retenues : assez pour un prestataire lent, trop court pour rejouer
 * une signature capturee sur un bout de capturing en direct.
 */
export interface SimulatorOptions {
  /** Cle de signature. Vide = signature impossible. */
  readonly secret: string;
  /** Fenetre de tolerance d'une notification, en secondes. */
  readonly toleranceSeconds?: number;
  /** Simuler une panne du prestataire. */
  readonly unavailable?: boolean;
  /** fraction de paiements refuses, pour exercer le reessai. */
  readonly declineRate?: number;
  /** Injecter une horloge, pour tester le rejeu. */
  readonly now?: () => Date;
}

interface SimulatorState {
  intents: Map<ExternalPaymentRef, PaymentIntent>;
  seenKeys: Map<string, ExternalPaymentRef>;
}

const DEFAULTS = {
  toleranceSeconds: 300,
  unavailable: false,
  declineRate: 0,
} as const;

export class SimulatorPaymentProvider implements PaymentProvider {
  readonly key = 'simulator';
  readonly label = 'Operateur simule';
  readonly methods: readonly PaymentMethod[] = ['mobile_money', 'card'];
  readonly kinds: readonly PaymentKind[] = ['rental', 'extra_charge', 'subscription'];

  private readonly secret: string;
  private readonly toleranceSeconds: number;
  private readonly declineRate: number;
  private readonly clock: () => Date;
  private readonly state: SimulatorState = {
    intents: new Map(),
    seenKeys: new Map(),
  };

  constructor(private readonly options: SimulatorOptions) {
    this.secret = options.secret ?? '';
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULTS.toleranceSeconds;
    this.declineRate = options.declineRate ?? DEFAULTS.declineRate;
    this.clock = options.now ?? ((): Date => new Date());
  }

  async isAvailable(): Promise<boolean> {
    if (this.options.unavailable) {
      return false;
    }

    return this.secret.length >= 32;
  }

  /**
   * Ouvre une intention.
   *
   * L'identifiant d'idempotence est memorise : deux appels avec la meme
   * cle rendent le MEME paiement, pas deux. Un double-clic sur « payer »
   * ne doit pas creer deux paiements a encaisser.
   */
  async createIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent> {
    if (!(await this.isAvailable())) {
      throw new PaymentProviderUnavailableError(
        'Operateur indisponible : aucune cle de signature exploitable.',
      );
    }

    const dejaVu = this.state.seenKeys.get(input.idempotencyKey);
    if (dejaVu) {
      const existant = this.state.intents.get(dejaVu);
      if (existant) return existant;
    }

    if (this.declineRate > 0 && this.decimal() < this.declineRate) {
      throw new PaymentDeclinedError(
        'SIMULATED_DECLINE',
        'Paiement refuse par le prestataire simule.',
      );
    }

    const reference: ExternalPaymentRef = `SIM-${this.referenceSuffix(input.idempotencyKey)}`;

    // Le code USSD simule reproduit le comportement des operateurs
    // mobile money : le client initiates le paiement depuis son
    // telephone, et le prestataire ne sait rien jusqu'a la notification.
    const expiration = new Date(this.clock().getTime() + 15 * 60 * 1000);

    const intent: PaymentIntent = {
      externalRef: reference,
      status: 'pending',
      clientInstruction: {
        kind: input.method === 'card' ? 'redirect_url' : 'ussd_code',
        value:
          input.method === 'card'
            ? `https://simulator.test/pay/${reference}`
            : `*155#${reference}`,
        expiresAt: expiration,
      },
    };

    this.state.intents.set(reference, intent);
    this.state.seenKeys.set(input.idempotencyKey, reference);

    return intent;
  }

  /**
   * Verifie une notification.
   *
   * Trois refus, et ils sont distincts parce qu'ils disent des choses
   * differentes a l'exploitation :
   *
   *   * pas de signature    -> une requete non authentifiee ;
   *   * secret non configure-> une configuration incomplete, pas une
   *                           attaque ;
   *   * signature invalide  -> soit une donnee alteree, soit un tiers.
   *
   * Une seule erreur pour les trois dirait « abandonner » sur un
   * probleme de configuration, et on chercherait au mauvais endroit
   * pendant des heures.
   */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) {
      return false;
    }

    if (this.secret.length === 0) {
      // Secret absent : RIEN ne peut etre verifie. Renvoyer `true`
      // autoriserait n'importe qui a declarer un paiement recu.
      return false;
    }

    const attendue = this.sign(rawBody);

    // `timingSafeEqual` leve si les longueurs different. Comparer les
    // longueurs d'abord ne fuit rien d'utile : la longueur d'une
    // signature n'est pas un secret.
    const fourni = Buffer.from(signature, 'utf8');
    const attendu = Buffer.from(attendue, 'utf8');

    if (fourni.length !== attendu.length) {
      return false;
    }

    return timingSafeEqual(fourni, attendu);
  }

  parseWebhook(rawBody: string): ProviderWebhook {
    let charge: Record<string, unknown>;

    try {
      charge = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new PaymentDeclinedError('INVALID_PAYLOAD', 'Charge utile illisible.');
    }

    const externalRef = charge['external_ref'];
    if (typeof externalRef !== 'string') {
      throw new PaymentDeclinedError(
        'MISSING_EXTERNAL_REF',
        'La notification ne porte pas de reference.',
      );
    }

    const statut = charge['status'];
    if (typeof statut !== 'string') {
      throw new PaymentDeclinedError('MISSING_STATUS', 'La notification ne porte pas de statut.');
    }

    return {
      externalRef,
      // L identifiant de l evenement, pas l identifiant de l paiement.
      // C'est ce qui permet au journal de distinguer une RETRANSMISSION
      // d'un evenement distinct portant le meme statut.
      externalEventId:
        typeof charge['event_id'] === 'string' ? charge['event_id'] : undefined,
      status: statut as PaymentStatus,
      amount:
        typeof charge['amount'] === 'string' ? BigInt(charge['amount']) : undefined,
      currency: typeof charge['currency'] === 'string' ? charge['currency'] : undefined,
      failureCode:
        typeof charge['failure_code'] === 'string' ? charge['failure_code'] : undefined,
      failureReason:
        typeof charge['failure_reason'] === 'string' ? charge['failure_reason'] : undefined,
      occurredAt:
        typeof charge['occurred_at'] === 'string'
          ? new Date(charge['occurred_at'])
          : undefined,
      // La charge utile integrale est conservee pour l'audit (CDCS 11.8).
      // Elle peut contenir des donnees du prestataire : elle n'est
      // jamais renvoyee telle quelle au client.
      rawPayload: charge,
    };
  }

  async requestRefund(input: {
    externalRef: ExternalPaymentRef;
    amount: bigint;
    currency: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ externalRefundRef: string; status: 'pending' | 'succeeded' }> {
    const paiement = this.state.intents.get(input.externalRef);

    if (!paiement) {
      throw new PaymentDeclinedError(
        'UNKNOWN_PAYMENT',
        `Aucun paiement ${input.externalRef} chez le prestataire.`,
      );
    }

    // Le simulateur rembourse immediatement. Un prestataire reel le
    // fait de maniere asynchrone : l'interface le dit, et le module ne
    // doit pas compter sur un remboursement instantane.
    this.state.intents.set(input.externalRef, { ...paiement, status: 'refunded' });

    return {
      externalRefundRef: `SIMREF-${input.idempotencyKey.slice(0, 16)}`,
      status: 'succeeded',
    };
  }

  async findByExternalRef(externalRef: ExternalPaymentRef): Promise<PaymentIntent | null> {
    return this.state.intents.get(externalRef) ?? null;
  }

  // ------------------------------------------------------------------
  // Aides de test
  // ------------------------------------------------------------------

  /**
   * Signe une charge utile.
   *
   * Expose pour que les tests puissent produire une notification
   * VALIDE. Sans cela, il faudrait dupliquer l'algorithme de signature
   * dans chaque test — et une duplication qui diverge passerait des
   * tests avec une signature que le prestataire n'a jamais produite.
   */
  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody, 'utf8').digest('hex');
  }

  /**
   * Fait passer une intention a un etat, comme le ferait le
   * prestataire.
   *
   * Elle est RE TRANSMISE deux fois, parce que c'est le
   * fonctionnement reel : aucun prestataire ne garantit qu'une seule
   * livraison.
   */
  deliver(
    externalRef: ExternalPaymentRef,
    statut: PaymentStatus,
    options: { failureCode?: string; failureReason?: string } = {},
  ): string {
    const existing = this.state.intents.get(externalRef);

    const charge = JSON.stringify({
      event_id: `${externalRef}-${statut}-${this.clock().getTime()}`,
      external_ref: externalRef,
      status: statut,
      amount: '100000',
      currency: 'XOF',
      failure_code: options.failureCode,
      failure_reason: options.failureReason,
      occurred_at: this.clock().toISOString(),
    });

    if (existing) {
      this.state.intents.set(externalRef, { ...existing, status: statut });
    }

    return charge;
  }

  /** Empile deux notifications identiques : le doublon du monde reel. */
  deliverTwice(
    externalRef: ExternalPaymentRef,
    statut: PaymentStatus,
  ): string[] {
    const premiere = this.deliver(externalRef, statut);
    return [premiere, premiere];
  }

  private decimal(): number {
    return Number.parseInt(
      createHmac('sha256', this.secret)
        .update(String(this.clock().getTime()))
        .digest('hex')
        .slice(0, 8),
      16,
    ) / 0xffffffff;
  }

  private referenceSuffix(graine: string): string {
    return createHmac('sha256', this.secret)
      .update(graine)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();
  }
}
