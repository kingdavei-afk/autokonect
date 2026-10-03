/**
 * Tarification d'une reservation (CDCS 8.4).
 *
 * ------------------------------------------------------------------------
 * FONCTIONS PURES, VOLONTAIREMENT
 * ------------------------------------------------------------------------
 * Aucun acces base, aucune date « maintenant », aucune variable
 * d'environnement. Une fonction de tarification qui lit l'heure système
 * n'est pas testable : on ne peut pas Reproduire le cas d'une restitution
 * a 23 h 47, ni celui d'une location de 25 heures.
 *
 * Le service passe donc explicitement les instants. Chaque fonction est
 * verifiee sur ses bornes — exactement la ou les litiges se produisent.
 *
 * ------------------------------------------------------------------------
 * LES REGLES, ET LEUR JUSTIFICATION
 * ------------------------------------------------------------------------
 * | Cas (CDCS 8.4)                            | Regle appliquee          |
 * |-------------------------------------------|--------------------------|
 * | Retrait et restitution a la meme heure     | nombre de jours entiers, minimum 1 |
 * | Periode de grace                           | 30 min apres l'echeance |
 * | Depassement                                | a l'heure entamee       |
 *
 * **Pourquoi un minimum d'un jour.** Une location de deux heures ne
 * peut pas valoir moins d'une journee : la preparation du vehicule, la
 * remise des cles et le nettoyage ne sont pas proportionnels a la duree.
 * Sans ce minimum, un client reserving 23 h 59 le lundi et 00 h 01 le
 * mardi paierait une fraction de journee pour immobiliser le vehicule
 * toute une nuit.
 *
 * **Pourquoi une periode de grace.** Une restitution a 10 h 12 pour une
 * echeance a 10 h 00 correspond a un retard de douze minutes, pas a une
 * heure. Sans grace, chaque minute de retard declenche une facturation et
 * un litige : la sanction devient automatique et le client prefere
 * appeler plutot que reguler.
 *
 * **Pourquoi l'heure entamee.** Un depart a 10 h 01 compte comme une
 * heure de depassement. L'arrondi favorable au client aurait un cout
 * invisible pour lui et un effet d'entrainement sur la qualite du parc.
 */

import {
  addCents,
  cents,
  divideCentsCeil,
  multiplyCents,
  type Centimes,
} from '../money/cents.js';

/** Duree d'une journee de location, en millisecondes. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Duree d'une heure, en millisecondes. */
export const HOUR_MS = 60 * 60 * 1000;

/**
 * Periode de grace avant facturation du depassement (CDCS 8.4).
 *
 * Vingt minutes suffiraient dans le cas courant ; trente minutes
 * absorment le temps de ranger le vehicule et de chercher les clefs.
 */
export const GRACE_PERIOD_MS = 30 * 60 * 1000;

/** Nombre de jours factures au minimum. */
export const MINIMUM_BILLED_DAYS = 1;

export interface PricingInput {
  /** Tarif journalier du vehicule, en centimes. */
  dailyRate: Centimes;
  /** Caution demandee, en centimes. Hors commission (CDCS 8.5). */
  depositAmount: Centimes;
  /** Debut de la location. */
  startAt: Date;
  /** Fin prevue de la location. */
  endAt: Date;
}

export interface PricingBreakdown {
  /** Nombre de jours factures. */
  billedDays: number;
  /** Duree reelle demandee, en millisecondes. */
  durationMs: number;
  /** Part location, hors caution. */
  rentalAmount: Centimes;
  /** Caution. */
  depositAmount: Centimes;
  /** Somme des deux : ce que le client doit au total. */
  totalAmount: Centimes;
  /** Detail fige dans `booking.pricing_snapshot`. */
  lines: PricingLine[];
}

export interface PricingLine {
  label: string;
  quantity: number;
  unitAmount: Centimes;
  amount: Centimes;
}

/**
 * Nombre de jours factures.
 *
 * Journee entiere, minimum une (voir l'en-tete du module).
 *
 * @throws Error si la fin n'est pas strictement posterieure au debut.
 */
export function computeBilledDays(startAt: Date, endAt: Date): number {
  const durationMs = endAt.getTime() - startAt.getTime();

  if (Number.isNaN(durationMs)) {
    throw new Error('Dates invalides dans le calcul de la duree.');
  }

  if (durationMs <= 0) {
    throw new Error(
      `Fin de locationposterieure au debut attendue : ` +
        `${startAt.toISOString()} -> ${endAt.toISOString()}.`,
    );
  }

  const days = Math.floor(durationMs / DAY_MS);

  return Math.max(MINIMUM_BILLED_DAYS, days);
}

/**
 * Calcule le devis d'une reservation.
 *
 * Le resultat est fige dans `booking.pricing_snapshot` a la creation et
 * ne doit plus jamais etre recalcule (CDCS 7.5) : une facture deja
 * presentee ne bouge pas.
 */
export function computePricing(input: PricingInput): PricingBreakdown {
  if (input.dailyRate <= 0n) {
    throw new Error('Le tarif journalier doit etre superieur a zero.');
  }

  if (input.depositAmount < 0n) {
    throw new Error('La caution ne peut pas etre negative.');
  }

  const billedDays = computeBilledDays(input.startAt, input.endAt);
  const durationMs = input.endAt.getTime() - input.startAt.getTime();
  const rentalAmount = multiplyCents(input.dailyRate, billedDays);

  const lines: PricingLine[] = [
    {
      label: `Location ${billedDays} jour(s) a ${input.dailyRate} XOF`,
      quantity: billedDays,
      unitAmount: input.dailyRate,
      amount: rentalAmount,
    },
  ];

  if (input.depositAmount > 0n) {
    lines.push({
      label: 'Caution (restituee apres restitution)',
      quantity: 1,
      unitAmount: input.depositAmount,
      amount: input.depositAmount,
    });
  }

  return {
    billedDays,
    durationMs,
    rentalAmount,
    depositAmount: input.depositAmount,
    // La caution S AJOUTE au total : c'est de l'argent que le client
    // laisse en garantie et qu'il recuperera. Elle n'est donc pas
    // reversee au partenaire, et n'entre pas dans la base commissionnable
    // (CDCS 8.5).
    totalAmount: addCents(rentalAmount, input.depositAmount),
    lines,
  };
}

export interface OvertimeInput {
  /** Tarif journalier, en centimes. */
  dailyRate: Centimes;
  /** Restitution prevue. */
  dueAt: Date;
  /** Restitution effective. */
  actualAt: Date;
  /** Periode de grace, en millisecondes. */
  graceMs?: number;
}

export interface OvertimeBreakdown {
  /** Retard brut, avant grace. */
  lateMs: number;
  /** Retard retenu apres grace. */
  billableLateMs: number;
  /** Heures entamees. Zero si aucun depassement facturable. */
  billableHours: number;
  /** Montant du depassement. */
  amount: Centimes;
}

/**
 * Calcule le depassement de restitution (CDCS 8.4).
 *
 * Facture a l'heure entamee, au tarif horaire journalier prorata.
 *
 * ------------------------------------------------------------------------
 * POURQUOI `divideCentsCeil` ET NON UNE DIVISION SIMPLE
 * ------------------------------------------------------------------------
 * Un tarif journalier de 100 000 donne 4 166,67 par heure. Une division
 * entiere donnerait 4 166, soit 1,67 de moins par heure — invisible sur
 * une heure, puis 40 sur une location de 24 heures de retard, et toujours
 * au detriment du partenaire.
 *
 * L'arrondi se fait vers le haut, ce qui garantit qu'aucune minute de
 * retard n'est gratuite pour la plateforme.
 */
export function computeOvertime(input: OvertimeInput): OvertimeBreakdown {
  if (input.dailyRate <= 0n) {
    throw new Error('Le tarif journalier doit etre superieur a zero.');
  }

  const graceMs = input.graceMs ?? GRACE_PERIOD_MS;

  const lateMs = Math.max(0, input.actualAt.getTime() - input.dueAt.getTime());
  const billableLateMs = Math.max(0, lateMs - graceMs);

  // Heure entamee : 1 minute de retard compte pour une heure.
  const billableHours = Math.ceil(billableLateMs / HOUR_MS);

  const amount =
    billableHours === 0
      ? (0n as Centimes)
      : divideCentsCeil(multiplyCents(input.dailyRate, billableHours), 24);

  return { lateMs, billableLateMs, billableHours, amount };
}

/** Tarif horaire prorata, pour affichage dans l'application. */
export function hourlyRate(dailyRate: Centimes): Centimes {
  return divideCentsCeil(dailyRate, 24);
}

/**
 * Verifie qu'une plage est couverte par une disponibilite de type
 * `available` declaree (CDCS 8.6).
 *
 * Distinct du controle de chevauchement entre reservations : celui-ci
 * est garanti par la base, celui-ci porte sur les blocages declares par
 * le fournisseur. Les deux sont necessaires.
 */
export function overlapsRange(
  rangeStart: Date,
  rangeEnd: Date,
  otherStart: Date,
  otherEnd: Date,
): boolean {
  // Bornes exclusives : une fin au meme instant qu'un debut est
  // compatible (fin le matin, prise en charge le meme matin).
  return rangeStart.getTime() < otherEnd.getTime() && otherStart.getTime() < rangeEnd.getTime();
}

/** Plafond de duree d'une location : garde-fou contre une saisie erronee. */
export const MAX_RENTAL_DAYS = 90;

/**
 * Verifie qu'une duree de location reste plausible.
 *
 * Sans plafond, une erreur de saisie — annee 2999 au lieu de 2029 —
 * produirait un devis de plusieurs milliards et un vehicule bloque
 * pendant des annees. La reservation serait alors impossible a annuler
 * puisque les transitions ne prevoient pas de sortie de `paid` apres
 * `in_progress`.
 */
export function assertPlausibleDuration(startAt: Date, endAt: Date): void {
  const days = Math.ceil((endAt.getTime() - startAt.getTime()) / DAY_MS);

  if (days > MAX_RENTAL_DAYS) {
    throw new Error(
      `Duree de location de ${days} jours, maximum ${MAX_RENTAL_DAYS}. ` +
        'Verifiez les dates saisies.',
    );
  }
}

/** Prix journalier minimum, en dessous duquel le marche est hors d'atteinte. */
export const MINIMUM_DAILY_RATE = cents(10_000);
