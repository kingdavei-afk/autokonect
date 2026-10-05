/**
 * @adkcars/contracts
 *
 * Contrats partages entre l'API, le site web et les applications
 * mobiles (ADR-001).
 *
 * Regle : une regle metier ecrite ici s'applique a TOUS les clients.
 * L'API l'importe pour valider, le front l'importe pour afficher les
 * memes transitions et les memes messages. Dupliquer ces regles dans
 * chaque surface est ce qui les fait diverger.
 */

// ---- Machine a etats (CDCS 8.1) ------------------------------------------
export {
  ACTIVE_STATUSES,
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  OCCUPYING_STATUSES,
  REFUNDED_STATUSES,
  TERMINAL_STATUSES,
  TransitionNotAllowedError,
  allowedTransitions,
  allowedTransitionsForActor,
  assertTransition,
  bookingStatusSchema,
  canTransition,
  isActive,
  isBookingStatus,
  isCancellableByClient,
  isTerminal,
  occupiesVehicle,
  wasRefunded,
} from './booking/state-machine.js';
export type {
  ActiveStatus,
  BookingStatus,
  OccupyingStatus,
  RefundedStatus,
  TerminalStatus,
} from './booking/state-machine.js';

// ---- Contrats de reservation (CDCS 8) -------------------------------------
export {
  availabilityQuerySchema,
  bookingDetailSchema,
  bookingFilterSchema,
  bookingHistoryEntrySchema,
  bookingIdSchema,
  bookingListSchema,
  bookingReferenceSchema,
  bookingSummarySchema,
  cancelBookingSchema,
  createBookingSchema,
  transitionBookingSchema,
} from './booking/booking.schema.js';
export type {
  AvailabilityQueryInput,
  BookingDetail,
  BookingFilterInput,
  BookingHistoryEntry,
  BookingSummary,
  CancelBookingInput,
  CreateBookingInput,
  TransitionBookingInput,
} from './booking/booking.schema.js';

// ---- Tarification (CDCS 8.4) ----------------------------------------------
export {
  DAY_MS,
  GRACE_PERIOD_MS,
  HOUR_MS,
  MAX_RENTAL_DAYS,
  MINIMUM_BILLED_DAYS,
  MINIMUM_DAILY_RATE,
  assertPlausibleDuration,
  computeBilledDays,
  computeOvertime,
  computePricing,
  hourlyRate,
  overlapsRange,
} from './booking/pricing.js';
export type {
  OvertimeBreakdown,
  OvertimeInput,
  PricingBreakdown,
  PricingInput,
  PricingLine,
} from './booking/pricing.js';

// ---- Montants (CDCS 4.3) --------------------------------------------------
export {
  addCents,
  applyRate,
  cents,
  divideCentsCeil,
  formatMoney,
  isNegative,
  isZero,
  maxCents,
  minCents,
  money,
  multiplyCents,
  subtractCents,
  sumMoney,
  toNumber,
} from './money/cents.js';
export type { Centimes, CurrencyCode, Money } from './money/cents.js';

// ---- Revue administrative des vehicules (CDCS 7.2) -----------------------
export {
  reviewDecisionSchema,
  reviewDocumentDecisionSchema,
  reviewDocumentSchema,
  reviewOutcomeSchema,
  reviewQueueItemSchema,
  reviewQueueQuerySchema,
  vehicleReviewDetailSchema,
  vehicleReviewStatusSchema,
} from './admin/vehicle-review.schema.js';
export type {
  ReviewDecision,
  ReviewDocument,
  ReviewDocumentDecision,
  ReviewOutcome,
  ReviewQueueItem,
  ReviewQueueQuery,
  VehicleReviewDetail,
} from './admin/vehicle-review.schema.js';

// ---- Catalogue vehicule (CDCS 6.2, 9, 10) ---------------------------------
export {
  buildPagination,
  countryCodeSchema,
  createVehicleSchema,
  fuelSchema,
  moneyInputSchema,
  moneyOutputSchema,
  paginated,
  paginationQuerySchema,
  paginationSchema,
  plateSchema,
  ratingOutputSchema,
  transmissionSchema,
  updateVehicleSchema,
  uploadDocumentSchema,
  uuidSchema,
  vehicleDetailSchema,
  vehicleDocumentKindSchema,
  vehicleDocumentSchema,
  vehicleMediaSchema,
  vehicleSearchSchema,
  vehicleSummarySchema,
  publicationReadinessSchema,
} from './vehicle/vehicle.schema.js';
export type {
  CreateVehicleInput,
  Pagination,
  PublicationReadiness,
  UpdateVehicleInput,
  UploadDocumentInput,
  VehicleDetail,
  VehicleSearchInput,
  VehicleSummary,
} from './vehicle/vehicle.schema.js';

// ---------------------------------------------------------------------------
// Paiement (CDCS 14.2)
// ---------------------------------------------------------------------------
// Ces deux fichiers sont la source unique de verite du module Paiement.
// Ils sont aussi, depuis la migration 0008, DOUBLES par un catalogue en
// base (`payment_status_transition`) : le code autorise selon les
// transitions declarees ici, la base impose selon les siennes.
//
// Un declencheur detecte la divergence a l'ecriture. Aucun test ne le
// ferait : les tests unitaires verifient ce fichier, les tests SQL
// verifient la base, et aucun ne regarde l'autre.
export {
  assertPaymentTransition,
  canTransitionPayment,
  isPaymentSettled,
  isPaymentStatus,
  isPaymentTerminal,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_SETTLED_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_TERMINAL_STATUSES,
  PAYMENT_TRANSITIONS,
  PaymentTransitionNotAllowedError,
  REFUND_KINDS,
  REFUND_STATUSES,
  shouldIgnoreRepeatedWebhook,
} from './payment/payment-state-machine.js';
export type {
  PaymentKind,
  PaymentMethod,
  PaymentStatus,
  PaymentTerminalStatus,
  RefundKind,
  RefundStatus,
} from './payment/payment-state-machine.js';

export { PaymentDeclinedError, PaymentProviderUnavailableError } from './payment/payment-provider.js';
export type {
  CreatePaymentIntentInput,
  ExternalPaymentRef,
  PaymentIntent,
  PaymentProvider,
  ProviderWebhook,
} from './payment/payment-provider.js';

// Schemas d'entree et de sortie du module Paiement.
export {
  createPaymentRequestSchema,
  externalRefSchema,
  paymentIntentSchema,
  paymentKindSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  providerWebhookSchema,
  requestRefundSchema,
  webhookOutcomeSchema,
} from './payment/payment.schema.js';
export type {
  CreatePaymentRequest,
  PaymentIntentOutput,
  ProviderWebhookInput,
  RequestRefundInput,
  WebhookOutcome,
} from './payment/payment.schema.js';
