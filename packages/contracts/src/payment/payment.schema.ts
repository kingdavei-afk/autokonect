import { z } from 'zod';

import { moneyOutputSchema, uuidSchema } from '../vehicle/vehicle.schema.js';

/**
 * Contrats du module Paiement (CDCS 14).
 *
 * ------------------------------------------------------------------------
 * L'ENTREE EST CONTROLEE, LA SORTIE NE L'EST PAS ENCORE
 * ------------------------------------------------------------------------
 * Une intention de paiement est une entree : elle vient du client, elle
 * sera refusee si elle est malformee. Elle est donc validee.
 *
 * Une reponse de paiement contient ce que l'operateur a reellement
 * enregistre. Elle est verifiee a l'ecriture du module (voir
 * `payment.mapper.ts`), pas par un schema — parce qu'une reponse qui
 * diverge de son contrat doit echouer a la production du reponse, la ou
 * l'on peut encore nommer le fichier fautif.
 *
 * L'asymetrie est donc voulue, et non un oubli : les entrees viennent
 * de l'exterieur, les sorties viennent de notre code.
 */

const paymentStatusSchema = z.enum([
  'pending',
  'authorized',
  'paid',
  'failed',
  'cancelled',
  'refunded',
]);

const paymentMethodSchema = z.enum(['mobile_money', 'card', 'cash', 'transfer']);

const paymentKindSchema = z.enum([
  'rental',
  'deposit',
  'penalty',
  'extra_charge',
  'subscription',
]);

/**
 * Reference d'un paiement cote prestataire.
 *
 * Format volontairement structure : il apparait sur un releve bancaire,
 * donc il doit pouvoir se retrouver a l'oreille comme a l'oeil.
 */
const externalRefSchema = z
  .string()
  .min(4)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Caracteres non autorises dans une reference.');

/**
 * Ouverture d'une intention de paiement.
 *
 * Le client ne choisit QUE le moyen de paiement. Ni le montant, ni la
 * devise, ni la reference : ces trois valeurs viennent de la
 * reservation, et les laisser a l'appelant reviendrait a accepter le
 * prix d'un vehicule.
 */
export const createPaymentRequestSchema = z.object({
  bookingId: uuidSchema,
  method: paymentMethodSchema,

  /**
   * Moyen de retravail, si l'echec est temporaire.
   *
   * On ne passe PAS une carte ni un code USSD : ces valeurs seraient
   * stockees et reutilisees. Un client qui reclique refait un paiement,
   * ce qui est le comportement attendu et le seul sur.
   */
  retryOfPaymentId: uuidSchema.optional(),
});

// CreatePaymentRequest, et non CreatePaymentIntentInput : ce dernier
// nom est deja pris par l'entree envoyee AU PRESTATAIRE dans
// payment-provider.ts. Deux entrees opposees ne doivent pas porter
// le meme nom — celle du client ne doit pas se confondre avec celle
// que l'on envoie, et l'import errone est alors impossible a
// distinguer.
export type CreatePaymentRequest = z.infer<typeof createPaymentRequestSchema>;

/**
 * Reference d'un webhook.
 *
 * Ce n'est PAS une cle d'idempotence de notre fabrication : c'est
 * l'identifiant de l'EVENEMENT chez le prestataire. Deux appels a des
 * instants differents pour le meme evenement sont le meme evenement.
 *
 * Un webhook sans cet identifiant est refuse. L'identifiant est ce qui
 * rend le traitement « au plus une fois » possible : sans lui, on ne
 * sait pas distinguer un renvoi d'un nouvel evenement.
 */
export const providerWebhookSchema = z.object({
  externalEventId: externalRefSchema,
  externalRef: externalRefSchema,
  status: paymentStatusSchema,
  amount: moneyOutputSchema.optional(),
  currency: z.string().length(3).optional(),
  failureCode: z.string().max(64).optional(),
  failureReason: z.string().max(500).optional(),
  occurredAt: z.string().datetime().optional(),
});

export type ProviderWebhookInput = z.infer<typeof providerWebhookSchema>;

/**
 * Demande de remboursement.
 *
 * `amount` est explicite et non calcule. Le CDCS 4.6 ne tranche pas
 * encore le bareme des litiges (A-04), donc le module ne peut pas
 * deduire seul le montant du. Exiger une decision explicite evite
 * d'appliquer une regale qui n'a pas ete decidee.
 */
export const requestRefundSchema = z.object({
  paymentId: uuidSchema,
  amount: moneyOutputSchema,
  reason: z.string().min(5).max(500),
  /**
   * Nature du remboursement. `deposit_release` restitue la caution,
   * `deposit_capture` la retient au titre des dommages. Les deux ne se
   * traitent pas de la meme facon et ne se justifie pas de la meme
   * explication.
   */
  kind: z.enum(['refund', 'deposit_release', 'deposit_capture', 'chargeback']).default('refund'),
});

export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

/**
 * Ce que le client doit faire pour finaliser un paiement.
 *
 * `instructions` est absent pour un paiement sans etape client — un
 * virement, un comptant enregistre par le proprietaire. L'interface ne
 * suppose donc pas que tout paiement est interactif, et ne doit pas
 * afficher un ecran « en attente de confirmation » pour un paiement
 * dont la confirmation ne depend pas du client.
 */
export const paymentIntentSchema = z.object({
  id: uuidSchema,
  bookingId: uuidSchema,
  bookingReference: z.string(),
  status: paymentStatusSchema,
  method: paymentMethodSchema,
  kind: paymentKindSchema,
  amount: moneyOutputSchema,
  currencyCode: z.string().length(3),
  providerKey: z.string(),
  externalRef: z.string().nullable(),
  instructions: z
    .object({
      kind: z.enum(['redirect_url', 'ussd_code', 'phone_number', 'none']),
      value: z.string(),
      expiresAt: z.string().optional(),
    })
    .optional(),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PaymentIntentOutput = z.infer<typeof paymentIntentSchema>;

/**
 * Resultat d'un webhook traite.
 *
 * `outcome` est ce que l'appelant — et l'exploitation — doit pouvoir
 * distinguer. Un webhook refuse et un webhook ignore ne se traitent pas
 * de la meme facon : le premier demande une investigation, le second
 * est le fonctionnement normal d'un prestataire qui retransmet.
 */
export const webhookOutcomeSchema = z.object({
  outcome: z.enum(['applied', 'ignored_duplicate']),
  paymentId: uuidSchema,
  status: paymentStatusSchema,
  bookingStatus: z.string().nullable(),
});

export type WebhookOutcome = z.infer<typeof webhookOutcomeSchema>;

export {
  paymentKindSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  externalRefSchema,
};
