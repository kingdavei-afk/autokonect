import { z } from 'zod';

import { bookingStatusSchema } from './state-machine.js';
import {
  buildPagination,
  moneyInputSchema,
  moneyOutputSchema,
  paginated,
  paginationQuerySchema,
  paginationSchema,  uuidSchema,
} from '../vehicle/vehicle.schema.js';

/**
 * Contrats de la reservation (CDCS 8).
 *
 * Les regles de tarification et de transitions vivent dans leurs propres
 * modules (`pricing.ts`, `state-machine.ts`). Ce fichier ne porte que
 * la FORME des echanges : ce qu'un client peut demander, ce qu'une
 * reponse contient.
 *
 * La separation n'est pas cosmetique. Un schema de validation qui
 * deciderait des regles metier les dupliquerait, et les deux versions
 * divergeraient — celle du serveur acceptant ce que l'application mobile
 * refuse, ou l'inverse.
 */

/** Identifiant de reservation. */
export const bookingIdSchema = uuidSchema;

/**
 * Plage de reservation.
 *
 * `endAt` posterieur a `startAt` est verifie par `computeBilledDays`,
 * qui refuse aussi les plages vides. La validation ici ne porte que sur
 * le FORMAT : une comparaison de dates dans un schema produirait un
 * message d'erreur technique, la ou le client comprendrait mieux
 * « la fin doit suivre le debut ».
 */
export const bookingRangeSchema = z
  .object({
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
  })
  .passthrough();

export type BookingRangeInput = z.infer<typeof bookingRangeSchema>;

/** Motif de reference courte, communique au client. */
export const bookingReferenceSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{6,12}$/, {
    message:
      'La reference doit comporter 6 a 12 caracteres en majuscules ou chiffres.',
  });

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export const createBookingSchema = z.object({
  vehicleId: uuidSchema,
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  pickupLocationId: uuidSchema.optional(),
  returnLocationId: uuidSchema.optional(),
  /** Aller simple (CDCS 6.3 F-29). */
  isOneWay: z.boolean().default(false),
  customerNotes: z.string().trim().max(1_000).optional(),

  // -------------------------------------------------------------------------
  // Montants acceptes en entree
  // -------------------------------------------------------------------------
  // Le client peut proposer une caution et un prix, et le serveur les
  // CONFIRMER ou les REFUSER. Il ne les accepte jamais tel quels.
  //
  // Cette distinction est ce qui distingue une place de marche d'un
  // système qui laisse le client fixer son propre prix.
  proposedTotal: moneyInputSchema.optional(),
  proposedDeposit: moneyInputSchema.optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export const bookingFilterSchema = z.object({
  status: bookingStatusSchema.optional(),
  /** `upcoming`, `current`, `past`, ou absent pour tout. */
  when: z.enum(['upcoming', 'current', 'past']).optional(),
  vehicleId: uuidSchema.optional(),
  // Pagination de REQUETE, pas de reponse. Voir l'avertissement sur
  // `paginationQuerySchema` : l'autre forme exigeait du client des
  // champs qu'il n'envoie jamais.
  ...paginationQuerySchema.shape,
});

export type BookingFilterInput = z.infer<typeof bookingFilterSchema>;

/**
 * Plage interrogee pour la disponibilite.
 *
 * Les deux bornes sont obligatoires. Rendre `startAt` facultatif
 * obligerait le service a traiter une plage vide, et une plage vide
 * signifie « rien n'est disponible » : la reponse serait « indisponible »
 * pour un vehicule parfaitement libre, ce qui est un bug difficile a
 * diagnostiquer cote client.
 */
export const availabilityQuerySchema = z
  .object({
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
  })
  .refine((value) => value.endAt.getTime() > value.startAt.getTime(), {
    message: 'La fin doit suivre le debut.',
    path: ['endAt'],
  });

export type AvailabilityQueryInput = z.infer<typeof availabilityQuerySchema>;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export const transitionReasonSchema = z.string().trim().max(500).optional();

/**
 * Transition demandee.
 *
 * `expectedVersion` est le verrou optimiste (CDCS 8.1). Il rend la
 * transition concurrente IMPOSSIBLE plutot que simplement improbable :
 *
 * Deux agents (le client sur son telephone, le fournisseur sur le
 * back-office) lisent la reservation en etat « payee » et demandent
 * chacun une transition differente. Sans version attendue, la seconde
 * ecrase la premiere : une annulation disparait, ou un vehicule est
 * declare « en cours » sur une reservation annulee.
 *
 * Avec version, la seconde requete est refusee en 409 et l'agent
 * recharge. C'est le seul mecanisme fiable quand il n'y a pas de
 * transaction longue tenant la ligne.
 */
export const transitionBookingSchema = z.object({
  to: bookingStatusSchema,
  expectedVersion: z.coerce.number().int().min(1),
  reason: transitionReasonSchema,
});

export type TransitionBookingInput = z.infer<typeof transitionBookingSchema>;

export const cancelBookingSchema = z.object({
  /** `client` ou `provider` : l acteur qui annule. */
  by: z.enum(['client', 'provider']),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.coerce.number().int().min(1),
});

export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;

// ---------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------

export const bookingSummarySchema = z.object({
  id: bookingIdSchema,
  reference: bookingReferenceSchema,
  status: bookingStatusSchema,
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  /**
   * Montants en chaine d'entiers, comme le catalogue vehicule.
   *
   * Un entier JS deborde a 2^53 : un total de location peut legitement
   * le depasser. La chaine est donc la forme de transport, et non une
   * commodite — le client la convertit avec `BigInt` ou la laisse
   * intacte pour l'afficher.
   *
   * ⚠️ `minor_units` vaut 0 pour le XOF : 3 500 000 signifie
   * 3 500 000 FRANCS, pas 35 000 (CDCS 4.3).
   */
  total: moneyOutputSchema,
  deposit: moneyOutputSchema,
  currencyCode: z.string().length(3),
  vehicle: z.object({
    id: uuidSchema,
    brand: z.string(),
    model: z.string(),
    plateNumber: z.string(),
  }),
  counterpart: z.object({
    /** `agency` ou `owner`. */
    providerType: z.enum(['agency', 'owner']),
    name: z.string(),
  }),
  createdAt: z.coerce.date(),
});

export type BookingSummary = z.infer<typeof bookingSummarySchema>;

export const bookingHistoryEntrySchema = z.object({
  fromStatus: bookingStatusSchema.nullable(),
  toStatus: bookingStatusSchema,
  actorId: uuidSchema.nullable(),
  reason: z.string().nullable(),
  at: z.coerce.date(),
});

export type BookingHistoryEntry = z.infer<typeof bookingHistoryEntrySchema>;

export const bookingDetailSchema = bookingSummarySchema.extend({
  pricingSnapshot: z.record(z.unknown()),
  isOneWay: z.boolean(),
  customerNotes: z.string().nullable(),
  /** Transitions que l acteur courant peut demander, pour l affichage. */
  allowedTransitions: z.array(bookingStatusSchema),
  version: z.number().int(),
  confirmedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  cancelledAt: z.coerce.date().nullable(),
  cancelReason: z.string().nullable(),
  history: z.array(bookingHistoryEntrySchema),
});

export type BookingDetail = z.infer<typeof bookingDetailSchema>;

export const bookingListSchema = paginated(bookingSummarySchema);
