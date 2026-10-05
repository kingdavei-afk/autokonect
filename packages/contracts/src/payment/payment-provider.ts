import type {
  PaymentKind,
  PaymentMethod,
  PaymentStatus,
} from './payment-state-machine.js';

/**
 * Abstraction des prestataires de paiement (CDCS 14.2).
 *
 * ------------------------------------------------------------------------
 * POURQUOI UNE INTERFACE, ET POURQUOI MAINTENANT
 * ------------------------------------------------------------------------
 * Les API Mobile Money en Cote d'Ivoire ont des cycles de vie
 * independants : chacun son bac a certification, sa documentation, son
 * rythme de evolution. Un caller qui connait un prestataire ne peut pas
 * etre ajoute sans toucher au reste du code.
 *
 * L'interface est donc posee **avant** le choix du prestataire de
 * reference (arbitrage A-02). Ce n'est pas premature : c'est
 * precisement ce qui permet d'en choisir un sans reecrire le module.
 *
 * ------------------------------------------------------------------------
 * CE QUE L'INTERFACE NE DOIT PAS FAIRE
 * ------------------------------------------------------------------------
 * Elle ne doit pas exposer les types du prestataire. Une signature qui
 * mentionne `OrangeMoneyError` oblige le service a dependre d'Orange
 * Money, et le remplacement devient une reecriture. Les erreurs sont donc
 * traduites en deux categories only : `PaymentDeclinedError` et
 * `PaymentProviderUnavailableError`.
 */

/** Reference d'un paiement chez le prestataire. */
export type ExternalPaymentRef = string;

/** Request d'ouverture d'une intention de paiement. */
export interface CreatePaymentIntentInput {
  /** Identifiant interne, stable, servant d'idempotence chez le PSP. */
  idempotencyKey: string;
  /** Montant en centimes. ⚠️ XOF : l'unite stockee est le FRANC. */
  amount: bigint;
  currency: string;
  method: PaymentMethod;
  /** Reference courte communiquee au client, affichee sur le relevé. */
  reference: string;
  /** Telephone du payeur, requis par les operateurs mobile money. */
  customerPhone?: string;
  /** Description visible par le payeur chez le prestataire. */
  description: string;
}

/** Resultat de l'ouverture d'une intention. */
export interface PaymentIntent {
  /** Identifiant de l'intention chez le prestataire. */
  externalRef: ExternalPaymentRef;
  status: PaymentStatus;
  /**
   * Ce que le client doit fournir pour finaliser : un URL, un code, un
   * numero de telephone.
   *
   * `undefined` pour un paiement sans etape client — un virement, ou un
   * paiement comptant enregistre par le fournisseur. L'interface ne
   * suppose donc pas que tout paiement est interactif.
   */
  clientInstruction?: {
    kind: 'redirect_url' | 'ussd_code' | 'phone_number' | 'none';
    value: string;
    expiresAt?: Date;
  };
}

/** Notification recue du prestataire. */
export interface ProviderWebhook {
  /** Reference de l'intention concernee. */
  externalRef: ExternalPaymentRef;

  /**
   * Identifiant de l EVENEMENT chez le prestataire.
   *
   * C'est lui qui fait l unicite du journal : deux appels a des instants
   * differents pour le meme evenement sont le meme evenement.
   *
   * Il ne doit PAS etre deduit de la reference et du statut. Ce couple
   * designe un ETAT, pas un evenement : il confondrait deux
   * notifications distinctes portant le meme statut, qui seraient alors
   * l'unee ignoree a tort.
   *
   * Tout prestataire expose ce champ. Ce module ne doit pas le deviner.
   */
  externalEventId?: string;
  status: PaymentStatus;
  /** Montant confirme par le prestataire, s'il le transmet. */
  amount?: bigint;
  currency?: string;
  /** Code d'echec interne du prestataire, pour le support. */
  failureCode?: string;
  failureReason?: string;
  /** Horodatage de l'evenement chez le prestataire. */
  occurredAt?: Date;
  /**
   * Charge utile integrale, conservee pour l'audit (CDCS 11.8).
   *
   * ⚠️ Elle peut contenir des donnees sensibles : elle est stockee, elle
   * n'est jamais renvoyee telle quelle au client.
   */
  rawPayload: Record<string, unknown>;
}

/**
 * Prestataire de paiement.
 *
 * Chaque implementation correspond a UN prestataire. Aucune fusion
 * (CDCS 14.2) : deux API dans une meme implementation rendraient
 * impossible le remplacement de l'une seule.
 */
export interface PaymentProvider {
  /** Identifiant stable, stocke dans `payment.provider_key`. */
  readonly key: string;

  /** Libelle affichable. */
  readonly label: string;

  /** Moyens de paiement acceptes par ce prestataire. */
  readonly methods: readonly PaymentMethod[];

  /** Types d'encaissement acceptes. `deposit` est souvent refuse. */
  readonly kinds: readonly PaymentKind[];

  /**
   * Le prestataire est-il joignable maintenant ?
   *
   * Utile avant d'ouvrir une intention : mieux vaut refuser
   * immediatement que d'enregistrer un paiement qui n'aboutira pas.
   */
  isAvailable(): Promise<boolean>;

  /** Ouvre une intention de paiement. */
  createIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent>;

  /**
   * Verifie l'authenticite d'une notification.
   *
   * ⚠️ Cette verification est le SEUL point de securite du module. Un
   * webhook non verifie permet a n'importe qui de declarer un paiement
   * recu, donc de confirmer une reservation sans avoir paye.
   *
   * L'interface impose donc de RENDRE UN BOOLEEN et de lever sur
   * echec, plutot que de retourner un objet a inspecter : une
   * verification qui retourne une structure peut etre oubliee par
   * l'appelant sans erreur de compilation.
   */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;

  /** Traduit une notification verifiee. */
  parseWebhook(rawBody: string): ProviderWebhook;

  /**
   * Demande un remboursement.
   *
   * Le remboursement est ASYNCHRONE dans la quasi-totalite des API : la
   * fonction confirme la reception de la demande, pas le versement.
   */
  requestRefund(input: {
    externalRef: ExternalPaymentRef;
    amount: bigint;
    currency: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ externalRefundRef: string; status: 'pending' | 'succeeded' }>;

  /**
   * Renseigne une reference de transaction bancaire ou mobile.
   *
   * Utilise pour la reconciliation (CDCS 14.3) : le journal du
   * prestataire est rapproche du notre a partir de cette reference.
   */
  findByExternalRef(externalRef: ExternalPaymentRef): Promise<PaymentIntent | null>;
}

/** Motifs de refus, independants du prestataire. */
export class PaymentDeclinedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentDeclinedError';
  }
}

/**
 * Le prestataire ne repond pas.
 *
 * Distinct de `PaymentDeclinedError` sur le plan metier : un refus est
 * definitif, une indisponibilite invite a reessayer. Les confondre
 * ferait perdre des paiements au client alors que le prestataire
 * fonctionne.
 */
export class PaymentProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderUnavailableError';
  }
}
