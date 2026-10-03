import { z } from 'zod';

import { moneyOutputSchema, uuidSchema, vehicleDocumentKindSchema } from '../vehicle/vehicle.schema.js';

/**
 * Contrats de la revue administrative des vehicules (CDCS 7.2, F-77).
 *
 * Le back-office doit pouvoir faire une file d'attente, examiner un
 * vehicule, decider, et motiver un refus. Le vocabulaire est partage avec
 * le front pour que les libelles d'ecran et les codes serveur ne
 * divergent pas.
 */

export const vehicleReviewStatusSchema = z.enum([
  'draft',
  'in_review',
  'published',
  'rejected',
  'archived',
]);

/** Ligne de la file d'attente : le strict necessaire pour trier et decider. */
export const reviewQueueItemSchema = z.object({
  id: uuidSchema,
  brand: z.string(),
  model: z.string(),
  year: z.number().int(),
  plateNumber: z.string(),
  status: vehicleReviewStatusSchema,
  categoryLabel: z.string(),
  dailyRate: moneyOutputSchema,
  currencyCode: z.string().length(3),
  withDriver: z.boolean(),
  ownerId: z.string().uuid().nullable(),
  ownerName: z.string().nullable(),
  /** Documents dont la date d'expiration est passee. */
  expiredDocumentCount: z.number().int(),
  submittedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

export const reviewQueueQuerySchema = z
  .object({
    status: z
      .enum(['in_review', 'rejected', 'published', 'all'])
      .default('in_review'),
    /** Filtre par proprietaire ou agence, via son identifiant. */
    ownerId: uuidSchema.optional(),
    q: z.string().trim().min(1).max(120).optional(),
    /** Tri : les plus anciens d'abord pour traiter la file dans l'ordre. */
    sort: z.enum(['oldest_first', 'newest_first', 'price_desc']).default('oldest_first'),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

/** Document vu par l'administrateur lors de la revue. */
export const reviewDocumentSchema = z.object({
  id: uuidSchema,
  kind: vehicleDocumentKindSchema,
  fileUrl: z.string().url(),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** Statut tel que vu maintenant, expiration recalculee a la lecture. */
  effectiveStatus: z.enum(['pending', 'valid', 'expired', 'rejected']),
  storedStatus: z.enum(['pending', 'valid', 'expired', 'rejected']),
  rejectReason: z.string().nullable(),
});
export type ReviewDocument = z.infer<typeof reviewDocumentSchema>;

export const vehicleReviewDetailSchema = z.object({
  vehicle: z.object({
    id: uuidSchema,
    brand: z.string(),
    model: z.string(),
    year: z.number().int(),
    plateCountry: z.string().length(2),
    plateNumber: z.string(),
    color: z.string().nullable(),
    transmission: z.string(),
    fuel: z.string(),
    seats: z.number().int(),
    airConditioning: z.boolean(),
    doors: z.number().int().nullable(),
    luggageCapacity: z.number().int().nullable(),
    consumption: z.number().nullable(),
    dailyRate: moneyOutputSchema,
    depositAmount: moneyOutputSchema,
    currencyCode: z.string().length(3),
    withDriver: z.boolean(),
    driverIncludedInRate: z.boolean(),
    minDays: z.number().int(),
    maxKmPerDay: z.number().int().nullable(),
    categoryLabel: z.string(),
    status: vehicleReviewStatusSchema,
    features: z.array(z.string()),
  }),
  provider: z.object({
    type: z.enum(['agency', 'owner']),
    id: z.string().uuid().nullable(),
    label: z.string(),
  }),
  documents: z.array(reviewDocumentSchema),
  /** Ce qui bloque encore la publication, pour l'afficher a l'administrateur. */
  blockers: z.array(z.string()),
  mediaCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VehicleReviewDetail = z.infer<typeof vehicleReviewDetailSchema>;

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const reviewDocumentDecisionSchema = z
  .object({
    documentId: uuidSchema,
    /** Un document rejete exige un motif. */
    rejectReason: z.string().trim().min(10, 'Motif de rejet requis (10 caracteres minimum).').max(500).optional(),
    accept: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.accept && !value.rejectReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectReason'],
        message:
          'Un document rejete doit etre motive : le fournisseur doit savoir quoi corriger.',
      });
    }
  });
export type ReviewDocumentDecision = z.infer<typeof reviewDocumentDecisionSchema>;

export const reviewDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    /** Motif obligatoire en cas de refus ; facultatif en cas de validation. */
    reason: z.string().trim().min(10, 'Motif de refus requis (10 caracteres minimum).').max(500).optional(),
    /** Notes internes facultatives, non visibles du fournisseur. */
    internalNote: z.string().trim().max(1_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'reject' && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message:
          'Un refus doit etre motive : un refus sans explication est inexploitable ' +
          'pour le fournisseur.',
      });
    }
  })
  .superRefine((value, ctx) => {
    if (value.action === 'approve' && value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message:
          'Le champ "reason" est reserve au refus. Utilisez "internalNote" pour une ' +
          'note conservee en interne lors d une validation.',
      });
    }
  });
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const reviewOutcomeSchema = z.object({
  vehicleId: uuidSchema,
  status: vehicleReviewStatusSchema,
  decisionAt: z.string(),
});
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;