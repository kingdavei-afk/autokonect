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