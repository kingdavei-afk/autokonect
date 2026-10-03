import { describe, expect, it } from 'vitest';

import {
  computeBilledDays,
  computeOvertime,
  computePricing,
  hourlyRate,
  MAX_RENTAL_DAYS,
  assertPlausibleDuration,
  overlapsRange,
  DAY_MS,
  GRACE_PERIOD_MS,
} from './pricing.js';
import { cents, formatMoney } from '../money/cents.js';

/**
 * Tests de la tarification (CDCS 8.4).
 *
 * Les cas limites sont testes en priorité : ce sont eux qui produisent
 * les litiges. Une regle qui marche « pour une location d'une semaine »
 * peut facturer le double sur une restitution de 30 minutes.
 */

const DAY = (n: number): Date => new Date(`2026-11-0${n}T08:00:00Z`);

describe('computeBilledDays', () => {
  it('compte des journees entieres', () => {
    expect(computeBilledDays(DAY(1), new Date(DAY(1).getTime() + 3 * DAY_MS))).toBe(3);
  });

  it('ne facture jamais moins d une journee', () => {
    // Une location de deux heures immobilise le vehicule pour une nuit
    // entiere : la preparation et le nettoyage ne sont pas proratises.
    expect(computeBilledDays(DAY(1), new Date(DAY(1).getTime() + 2 * 60 * 60 * 1000))).toBe(1);
  });

  it('ne facture pas une journee partielle', () => {
    // 23 h 59 : c'est une journee, pas deux.
    expect(computeBilledDays(DAY(1), new Date(DAY(1).getTime() + DAY_MS - 60_000))).toBe(1);
  });

  it('facture deux journees des 24 h pile', () => {
    expect(computeBilledDays(DAY(1), new Date(DAY(1).getTime() + 2 * DAY_MS))).toBe(2);
  });

  it('refuse une fin anterieure au debut', () => {
    expect(() => computeBilledDays(DAY(3), DAY(1))).toThrow(/posterieure au debut/);
  });

  it('refuse une fin identique au debut', () => {
    // Une duree nulle est un Intervalle vide : `booking_range_valid` la
    // refuse aussi en base. Les deux couches doivent etre d accord.
    expect(() => computeBilledDays(DAY(2), DAY(2))).toThrow(/posterieure au debut/);
  });
});

describe('computePricing', () => {
  it('multiplie le tarif par le nombre de jours', () => {
    const p = computePricing({
      dailyRate: cents(50_000),
      depositAmount: cents(0),
      startAt: DAY(1),
      endAt: new Date(DAY(1).getTime() + 3 * DAY_MS),
    });

    expect(p.billedDays).toBe(3);
    expect(p.rentalAmount).toBe(150_000n);
    expect(p.depositAmount).toBe(0n);
    expect(p.totalAmount).toBe(150_000n);
  });

  it('ajoute la caution au total sans la melanger au prix', () => {
    const p = computePricing({
      dailyRate: cents(50_000),
      depositAmount: cents(500_000),
      startAt: DAY(1),
      endAt: new Date(DAY(1).getTime() + 2 * DAY_MS),
    });

    // La caution s'ajoute au total mais reste une ligne distincte : elle
    // n'est pas un revenu et n'entre pas dans la base commissionnable.
    expect(p.rentalAmount).toBe(100_000n);
    expect(p.depositAmount).toBe(500_000n);
    expect(p.totalAmount).toBe(600_000n);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[1]?.label).toMatch(/Caution/);
  });

  it('refuse un tarif journalier nul', () => {
    expect(() =>
      computePricing({
        dailyRate: cents(0),
        depositAmount: cents(0),
        startAt: DAY(1),
        endAt: DAY(2),
      }),
    ).toThrow(/superieur a zero/);
  });

  it('refuse une caution negative', () => {
    expect(() =>
      computePricing({
        dailyRate: cents(50_000),
        depositAmount: cents(-1),
        startAt: DAY(1),
        endAt: DAY(2),
      }),
    ).toThrow(/ne peut pas etre negative/);
  });

  it('produit un devis sans arithmetique flottante', () => {
    // 7 x 33333 = 233331. En flottant, 7 * 33333.33 donnerait
    // 233333.30999999997 : un franc d'ecart par reservation.
    const p = computePricing({
      dailyRate: cents(33_333),
      depositAmount: cents(1),
      startAt: DAY(1),
      endAt: new Date(DAY(1).getTime() + 7 * DAY_MS),
    });

    expect(p.totalAmount).toBe(233_332n);
  });
});

describe('computeOvertime', () => {
  const dailyRate = cents(100_000);

  it('ne facture rien avant l echeance', () => {
    const o = computeOvertime({ dailyRate, dueAt: DAY(2), actualAt: DAY(1) });

    expect(o.amount).toBe(0n);
    expect(o.billableHours).toBe(0);
  });

  it('ne facture rien pendant la periode de grace', () => {
    const due = DAY(2);
    const actual = new Date(due.getTime() + GRACE_PERIOD_MS);

    const o = computeOvertime({ dailyRate, dueAt: due, actualAt: actual });

    // 30 min pile : c'est la grace, pas un depassement.
    expect(o.lateMs).toBe(GRACE_PERIOD_MS);
    expect(o.billableLateMs).toBe(0);
    expect(o.amount).toBe(0n);
  });

  it('facture une heure entamee des la premiere minute hors grace', () => {
    const due = DAY(2);
    const actual = new Date(due.getTime() + GRACE_PERIOD_MS + 60_000);

    const o = computeOvertime({ dailyRate, dueAt: due, actualAt: actual });

    // 31 minutes de retard : une heure entamee, donc une heure facturee.
    expect(o.billableHours).toBe(1);
    expect(o.amount).toBe(hourlyRate(dailyRate));
  });

  it('arrondit le tarif horaire vers le haut', () => {
    // 100 000 / 24 = 4 166,666...
    // Une division entiere donnerait 4 166, soit 1,67 de moins par
    // heure — invisible seule, mais 40 par jour de retard.
    expect(hourlyRate(dailyRate)).toBe(4_167n);

    const o = computeOvertime({
      dailyRate,
      dueAt: DAY(2),
      actualAt: new Date(DAY(2).getTime() + 24 * 60 * 60 * 1000 + GRACE_PERIOD_MS),
    });

    expect(o.billableHours).toBe(24);
    expect(o.amount).toBe(100_000n);
  });

  it('facture au prorata pour une duree qui ne tombe pas juste', () => {
    const o = computeOvertime({
      dailyRate,
      dueAt: DAY(2),
      actualAt: new Date(DAY(2).getTime() + GRACE_PERIOD_MS + 5 * 60 * 60 * 1000),
    });

    expect(o.billableHours).toBe(5);
    // 5 x 100 000 / 24 = 20 833,33 -> 20 834
    expect(o.amount).toBe(20_834n);
  });

  it('ne facture jamais le double pour un retour a l heure exacte', () => {
    // Un depart pile n'est pas un depassement d une heure.
    const o = computeOvertime({ dailyRate, dueAt: DAY(2), actualAt: DAY(2) });

    expect(o.amount).toBe(0n);
  });
});

describe('overlapsRange', () => {
  it('detecte un chevauchement strict', () => {
    expect(overlapsRange(DAY(1), DAY(3), DAY(2), DAY(4))).toBe(true);
  });

  it('accepte une fin et un debut au meme instant', () => {
    // Fin le matin et prise en charge le meme matin : c'est compatible.
    // Le sens inverse doit etre vrai aussi, sans quoi l'un des deux
    //Extreme serait refuse a tort.
    expect(overlapsRange(DAY(1), DAY(2), DAY(2), DAY(3))).toBe(false);
    expect(overlapsRange(DAY(2), DAY(3), DAY(1), DAY(2))).toBe(false);
  });

  it('accepte deux plages disjointes', () => {
    expect(overlapsRange(DAY(1), DAY(2), DAY(3), DAY(4))).toBe(false);
  });

  it('detecte le containment', () => {
    expect(overlapsRange(DAY(2), DAY(3), DAY(1), DAY(5))).toBe(true);
  });
});

describe('assertPlausibleDuration', () => {
  it('accepte une location ordinaire', () => {
    expect(() =>
      assertPlausibleDuration(DAY(1), new Date(DAY(1).getTime() + 7 * DAY_MS)),
    ).not.toThrow();
  });

  it('refuse une saisie aberrante', () => {
    // Une annee 2999 au lieu de 2029 bloquerait le vehicule pendant
    // des millenaires, et aucune transition ne permetrait d'en sortir.
    expect(() =>
      assertPlausibleDuration(DAY(1), new Date('2999-01-01T08:00:00Z')),
    ).toThrow(/maximum 90/);
  });

  it('laisse passer la limite exacte', () => {
    expect(() =>
      assertPlausibleDuration(DAY(1), new Date(DAY(1).getTime() + MAX_RENTAL_DAYS * DAY_MS)),
    ).not.toThrow();
  });
});

describe('formatage des montants', () => {
  it('affiche le XOF sans subunit', () => {
    // Le franc CFA n'a pas de centimes : afficher « 3 500 000,00 XOF »
    // ferait croire a un arrondi qui n'a pas eu lieu.
    //
    // Le separateur de milliers n'est PAS compare : selon la version
    // d'ICU, `fr-CI` utilise une espace insecable etroite (U+202F) et
    // non une espace ordinaire. Ecrire l'espace « a la main » rendrait
    // le test dependant de la version d'ICU installee, et il echouerait
    // sans qu'aucune regle metier n'ait change. Ce qui compte est
    // verifie : aucun separateur decimal, et la devise presente.
    const rendered = formatMoney(cents(3_500_000), 'XOF');

    expect(rendered.endsWith('XOF')).toBe(true);
    expect(rendered).not.toMatch(/[.,]\d{2}\s*XOF$/);
    expect(rendered.replace(/\D/g, '')).toBe('3500000');
  });

  it('conserve deux decimales pour une devise a subunit', () => {
    // 12 300 centimes sont 123,00 EUR : arrondir a « 123 EUR » ferait
    // croire que la facture a ete arrondie.
    expect(formatMoney(cents(12_300), 'EUR')).toMatch(/123,00\s*EUR$/);
  });
});
