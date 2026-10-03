/**
 * Machine a etats de la reservation (CDCS 8.1).
 *
 * SOURCE UNIQUE DE VERITE, partagee par l'API, le site et les
 * applications mobiles. Une transition impossible est donc impossible
 * partout : l'API ne peut pas l'autoriser, le front ne peut pas
 * l'afficher.
 *
 * Cette table est volontairement declaree sous forme de donnees pures,
 * plutot que codee dans une classe ou une serie de `if`. On peut ainsi
 * la comparer a la contrainte SQL correspondante, la serialiser pour le
 * client, et la tester exhaustivement.
 */

import { z } from 'zod';

export const BOOKING_STATUSES = [
  'draft',
  'awaiting_payment',
  'paid',
  'in_progress',
  'late_return',
  'completed',
  'disputed',
  'cancelled_client',
  'cancelled_provider',
  'expired',
  'resolved_client',
  'resolved_provider',
  'resolved_split',
  'closed',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Transitions autorisees. Graphe declare ici et valide par des tests
 * exhaustifs dans `state-machine.spec.ts`.
 */
export const BOOKING_TRANSITIONS: Readonly<
  Record<BookingStatus, readonly BookingStatus[]>
> = {
  // Le client constitue son panier sans s'engager.
  draft: ['awaiting_payment'],

  // Paiement en attente. Expire si le client ne paie pas.
  awaiting_payment: ['paid', 'expired'],

  // Payee : le vehicule est bloque. Peut etre annulee par l'une ou
  // l'autre partie tant que la prise en charge n'a pas eu lieu.
  paid: [
    'in_progress',
    'late_return',
    'disputed',
    'cancelled_client',
    'cancelled_provider',
  ],

  // Vehicule en location.
  in_progress: ['completed', 'late_return', 'disputed'],

  // Restitution hors delai : tarif horaire de depassement en cours.
  late_return: ['completed', 'disputed'],

  // Restituation effectuee, sans reclamation ouverte.
  completed: ['disputed', 'closed'],

  // Reclamation ouverte : la caution peut etre capturee ou restituee.
  disputed: ['resolved_client', 'resolved_provider', 'resolved_split'],

  // Issues d'un litige. Toutes.aboutissent a une fermeture.
  resolved_client: ['closed'],
  resolved_provider: ['closed'],
  resolved_split: ['closed'],

  // Etats terminaux : aucune sortie possible.
  cancelled_client: [],
  cancelled_provider: [],
  expired: [],
  closed: [],
} as const;

/**
 * Etats dans lesquels le vehicule est indisponible pour une autre
 * reservation.
 *
 * DOIT correspondre exactement a l'index partiel
 * `booking_occupancy_idx` de la migration : c'est le declencheur
 * `prevent_booking_overlap` qui s'appuie dessus. Une divergence entre
 * les deux listes autoriserait ou refuserait des reservations a tort.
 */
export const OCCUPYING_STATUSES = [
  'awaiting_payment',
  'paid',
  'in_progress',
  'late_return',
  'disputed',
] as const satisfies readonly BookingStatus[];

export type OccupyingStatus = (typeof OCCUPYING_STATUSES)[number];

/** Etats definitifs : aucune transition sortante. */
export const TERMINAL_STATUSES = [
  'cancelled_client',
  'cancelled_provider',
  'expired',
  'closed',
] as const satisfies readonly BookingStatus[];

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Etats pour lesquels le client ou le fournisseur a ete rembourse. */
export const REFUNDED_STATUSES = [
  'cancelled_client',
  'cancelled_provider',
  'resolved_client',
] as const satisfies readonly BookingStatus[];

export type RefundedStatus = (typeof REFUNDED_STATUSES)[number];

/** Etats actifs : la location a un effet financier en cours. */
export const ACTIVE_STATUSES = [
  'awaiting_payment',
  'paid',
  'in_progress',
  'late_return',
  'disputed',
] as const satisfies readonly BookingStatus[];

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export function isBookingStatus(value: string): value is BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(value);
}

/**
 * Liste des etats sous forme de schema.
 *
 * La validation Zod est derivee de `BOOKING_STATUSES` plutot que
 * redigee a part : une liste ecrite deux fois diverge des la premiere
 * evolution, et la divergence se manifeste comme un refus a tort d'un
 * etat valide.
 *
 * L'import de `zod` ici est justifie : ce module est la source unique de
 * verite des etats, donc c'est lui qui doit exposer la forme exploitable
 * par la validation d'entree.
 */
export const bookingStatusSchema = z.enum(
  BOOKING_STATUSES as unknown as [BookingStatus, ...BookingStatus[]],
);

export function isTerminal(status: BookingStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function occupiesVehicle(status: BookingStatus): status is OccupyingStatus {
  return (OCCUPYING_STATUSES as readonly string[]).includes(status);
}

export function isActive(status: BookingStatus): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function wasRefunded(status: BookingStatus): status is RefundedStatus {
  return (REFUNDED_STATUSES as readonly string[]).includes(status);
}

/** Transitions possibles depuis un etat donne. */
export function allowedTransitions(from: BookingStatus): readonly BookingStatus[] {
  return BOOKING_TRANSITIONS[from];
}

export function canTransition(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

/** Erreur levee lorsqu'une transition n'est pas autorisee. */
export class TransitionNotAllowedError extends Error {
  constructor(
    readonly from: BookingStatus,
    readonly to: BookingStatus,
    readonly allowed: readonly BookingStatus[],
  ) {
    super(
      `Transition non autorisee : ${from} -> ${to}. ` +
        `Transitions autorisees depuis ${from} : ` +
        `${allowed.length > 0 ? allowed.join(', ') : 'aucune (etat terminal)'}`,
    );
    this.name = 'TransitionNotAllowedError';
  }
}

/**
 * Verifie une transition et leve si elle est interdite.
 *
 * A appeler AVANT toute ecriture en base. La base conserve son propre
 * declencheur d'occupation, mais elle ne valide pas les transitions
 * d'etat : cette verification appartient au domaine.
 */
export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    throw new TransitionNotAllowedError(from, to, BOOKING_TRANSITIONS[from]);
  }
}

/**
 * Transitions possibles pour un acteur donne.
 *
 * Un client ne peut pas annuler une location deja restituee ; un
 * fournisseur ne peut pas Imposer une resolution de litige. Cette
 * contrainte est une AFFICHAGE et un UX : la verification de securite
 * reste faite par le service, cote API.
 */
export function allowedTransitionsForActor(
  from: BookingStatus,
  actor: 'client' | 'provider' | 'admin' | 'system',
): readonly BookingStatus[] {
  const all = BOOKING_TRANSITIONS[from];

  if (actor === 'admin' || actor === 'system') return all;

  if (actor === 'client') {
    return all.filter(
      (status) =>
        status !== 'closed' &&
        status !== 'resolved_provider' &&
        status !== 'resolved_split',
    );
  }

  // fournisseur
  return all.filter(
    (status) =>
      status !== 'closed' &&
      status !== 'resolved_client' &&
      status !== 'resolved_split',
  );
}

/** Etats dans lesquels le client peut encore annuler sans penalite majeure. */
export function isCancellableByClient(status: BookingStatus): boolean {
  return allowedTransitionsForActor(status, 'client').includes('cancelled_client');
}