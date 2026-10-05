/**
 * Machine a etats du paiement (CDCS 14.2).
 *
 * SOURCE UNIQUE DE VERITE, comme la machine a etats de la reservation.
 * La separation des deux est volontaire : un paiement peut aboutir
 * sans que la reservation soitConfirmee, et l'inverse est vrai aussi —
 * une reservation peut etre annulee alors qu'un paiement est en cours.
 * Confondre les deux graphs menait a des etats impossibles.
 *
 * ------------------------------------------------------------------------
 * CE QUE CETTE MACHINE PROTEGE CONTRE L'ARGUMENT LE PLUS REDOUTABLE
 * ------------------------------------------------------------------------
 * Un prestataire de paiement envoie des notifications **au moins une
 * fois**. C'est une garantie de son reseau, pas un bug : il ne peut pas
 * savoir si sa premiere notification est arrivee avant de la renvoyer.
 *
 * Un webhook duplique ne doit donc jamais :
 *   * debiter deux fois le client ;
 *   * crediter deux fois la commission ;
 *   * faire avancer la reservation de deux etats.
 *
 * Ces transitions sont donc **absentes** de la table. `paid -> paid` n
 * existe pas : le second webhook est refuse, et le paiement est laisse
 * dans son etat deja atteint.
 */

/** Etats d'un paiement, alignes sur la contrainte SQL de `payment.status`. */
export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'cancelled',
  'refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Transitions autorisees.
 *
 * `failed` a une sortie vers `pending` : un client dont l'echec vient
 * d'un solde insuffisant doit pouvoir reessayer avec un autre moyen de
 * paiement. Sans cette sortie, il devrait creer une nouvelle
 * reservation et perdre sa place dans le calendrier.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> =
  {
    // En attente de confirmation du prestataire.
    pending: ['authorized', 'paid', 'failed', 'cancelled'],

    // Reserve mais pas encore capture. La capture differee est la
    // regle de certains operateurs mobile money.
    authorized: ['paid', 'failed', 'cancelled'],

    // Encaissement effectif. Seul chemin vers le remboursement.
    paid: ['refunded'],

    // Echec : reessayable, mais seulement vers `pending`.
    failed: ['pending'],

    // Annule avant encaissement.
    cancelled: [],

    // Rembourse. Terminal.
    refunded: [],
  } as const;

/** Etats terminaux : aucune sortie. */
export const PAYMENT_TERMINAL_STATUSES = [
  'cancelled',
  'refunded',
] as const satisfies readonly PaymentStatus[];

export type PaymentTerminalStatus = (typeof PAYMENT_TERMINAL_STATUSES)[number];

/** Etats ou de l'argent a ete reellement deplace. */
export const PAYMENT_SETTLED_STATUSES = [
  'paid',
  'refunded',
] as const satisfies readonly PaymentStatus[];

/** Moyens de paiement. Alignes sur la contrainte SQL de `payment.method`. */
export const PAYMENT_METHODS = ['mobile_money', 'card', 'cash', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Nature de l'encaissement.
 *
 * La distinction n'est pas academique : la caution est de l'argent
 * **detenu** et restitue, pas un revenu. Le module Tresorerie les
 * cloisonne (CDCS 4.2 bis), et les confondre ferait porter de la
 * commission sur un montant qui n'appartient pas a la plateforme.
 */
export const PAYMENT_KINDS = [
  'rental',
  'deposit',
  'penalty',
  'extra_charge',
  'subscription',
] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** Etats de remboursement. Alignes sur la contrainte SQL de `refund.status`. */
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * Nature d'un remboursement.
 *
 * `deposit_release` restitue la caution, `deposit_capture` la retient.
 * Les deux ne se traitent pas de la meme facon : l'un rend de l'argent au
 * client, l'autre le transfere au partenaire au titre des dommages.
 */
export const REFUND_KINDS = [
  'refund',
  'deposit_release',
  'deposit_capture',
  'chargeback',
] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function isPaymentTerminal(status: PaymentStatus): status is PaymentTerminalStatus {
  return (PAYMENT_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isPaymentSettled(status: PaymentStatus): boolean {
  return (PAYMENT_SETTLED_STATUSES as readonly string[]).includes(status);
}

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Erreur levee lorsqu'une transition de paiement est interdite. */
export class PaymentTransitionNotAllowedError extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
    readonly allowed: readonly PaymentStatus[],
  ) {
    super(
      `Transition de paiement non autorisee : ${from} -> ${to}. ` +
        `Transitions autorisees depuis ${from} : ` +
        `${allowed.length > 0 ? allowed.join(', ') : 'aucune (etat terminal)'}`,
    );
    this.name = 'PaymentTransitionNotAllowedError';
  }
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) {
    throw new PaymentTransitionNotAllowedError(from, to, PAYMENT_TRANSITIONS[from]);
  }
}

/**
 * Un webhook repete doit-il etre traite ?
 *
 * ------------------------------------------------------------------------
 * LE CAS DELICIEUX : LE PRELEVEMENT APRES REFUS
 * ------------------------------------------------------------------------
 * Un client qui reclique « payer » apres un echec doit pouvoir
 * reussir. Or le paiement d'origine est `failed`, pas `paid`.
 *
 * La regle « un paiement deja termine se ignore » est donc appliquee
 * sur `paid` et `refunded` UNIQUEMENT, et jamais sur `failed` : c'est
 * ce qui distingue un doublon de paiement d'un nouvel essai.
 *
 * Une consequence moins evidente : si un prestataire confirme un
 * paiement que nous avions marque `failed` (injoignabilite du reseau,
 * timeout cote PSP), le webhook DOIT etre accepte. Sinon le client a
 * paye sans que la reservation soit confirmee, et l'argent reste
 * bloque sans que personne ne le voie.
 */
export function shouldIgnoreRepeatedWebhook(status: PaymentStatus): boolean {
  return status === 'paid' || status === 'refunded';
}
