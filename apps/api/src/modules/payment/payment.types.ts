/**
 * Types internes du module Paiement.
 *
 * Ces interfaces decrivent les LIGNES de base. Elles sont separees des
 * contrats `@adkcars/contracts` (ce que l'API expose) parce que les
 * deux ne doivent pas evoluer ensemble : une colonne ajoutee a une table
 * ne doit pas forcer a modifier un contrat public.
 */

import type { PaymentKind, PaymentMethod, PaymentStatus, RefundStatus } from '@adkcars/contracts';

/** Ligne de la table `payment`. */
export interface PaymentRow {
  id: string;
  booking_id: string;
  provider_key: string;
  method: PaymentMethod;
  kind: PaymentKind;
  amount: string;
  currency_code: string;
  status: PaymentStatus;
  external_ref: string | null;
  raw_payload: Record<string, unknown> | null;
  idempotency_key: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  paid_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
}

/** Ligne de `provider_webhook_delivery`. */
export interface WebhookDeliveryRow {
  id: string;
  provider_key: string;
  external_event_id: string;
  received_at: Date | null;
  processed_at: Date | null;
  process_outcome: string | null;
  payload_sha256: string;
  error_detail: string | null;
}

/**
 * ReservationJOINtee au paiement — le strict necessaire pour autoriser un
 * encaissement.
 *
 * Trois colonnes de trop, et la verification d'autorisation commence a
 * dependre de donnees qu'elle ne-Regarde pas. Ici, chacune est utilisee
 * par une verification nommee.
 */
export interface PayableBookingRow {
  id: string;
  reference: string;
  client_id: string;
  status: string;
  version: number;
  currency_code: string;
  funds_channel: string;
  total_amount: string;
  deposit_amount: string;
  /** `rentalAmount` du devis fige — jamais `total_amount`. */
  rental_amount: string | null;
}

/** Reservation vue par le client concerne. */
export interface PaymentOwnerRow {
  client_id: string;
  status: string;
  version: number;
}

/**
 * Ce qu'un adaptateur doit fournir pour qu'un webhook soit traite.
 *
 * Le registre resout l'identifiant du prestataire ; le service ne
 * cherche jamais un adaptateur « au hasard », parce qu'un webhook dont
 * on ne sait pas qui l'a envoye ne doit pas etre traite.
 */
export interface ResolvedWebhook {
  providerKey: string;
  rawBody: string;
  signature: string | undefined;
}

/** Journal d'un evenement refuse. */
export interface WebhookRejection {
  providerKey: string;
  externalEventId: string | undefined;
  payloadSha256: string;
  outcome: WebhookOutcomeKind;
  detail: string;
}

export type { RefundStatus };

/**
 * Issues possibles pour un evenement de notification.
 *
 * Distinguees parce qu'elles ne se traitent pas de la meme facon :
 * `rejected_signature` demande une investigation, `ignored_duplicate`
 * est le fonctionnement NORMAL d'un prestataire qui retransmet au moins
 * une fois. Les confondre ferait crier au|Pages l-incident a chaque
 * notification en double — c'est-a-dire en permanence.
 */
export type WebhookOutcomeKind =
  | 'applied'
  | 'ignored_duplicate'
  | 'rejected_signature'
  | 'rejected_unknown'
  | 'rejected_amount'
  | 'failed_processing';
