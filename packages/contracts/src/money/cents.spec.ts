import { describe, expect, it } from 'vitest';

import {
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
} from './cents';

describe('cents', () => {
  it('accepte un entier', () => {
    expect(cents(1000)).toBe(1000n);
  });

  it('accepte un bigint', () => {
    expect(cents(10_000n)).toBe(10_000n);
  });

  it('accepte la chaine renvoyee par le pilote pg', () => {
    expect(cents('1000')).toBe(1000n);
  });

  it('accepte les espaces autour de la chaine', () => {
    expect(cents('  1000  ')).toBe(1000n);
  });

  it('refuse un decimale', () => {
    // C'est le point critique : un arrondi silencieux sur un montant
    // produirait une facture fausse.
    expect(() => cents(100.5)).toThrow(/entier/);
  });

  it('refuse NaN et l infini', () => {
    expect(() => cents(Number.NaN)).toThrow();
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('refuse une chaine non numerique', () => {
    expect(() => cents('1000,50')).toThrow();
    expect(() => cents('mille')).toThrow();
    expect(() => cents('')).toThrow();
  });

  it('accepte un montant negatif pour un calcul', () => {
    expect(isNegative(cents(-500))).toBe(true);
    expect(isNegative(cents(500))).toBe(false);
  });

  it('reconnait le zero', () => {
    expect(isZero(cents(0))).toBe(true);
  });
});

describe('operations', () => {
  it('additionne sans perte', () => {
    // 0.1 + 0.2 !== 0.3 en flottant : le raison d etre du type.
    expect(addCents(cents(10), cents(20))).toBe(30n);
    expect(addCents(cents(999_999_999), cents(1))).toBe(1_000_000_000n);
  });

  it('additionne un nombre variable de montants', () => {
    expect(addCents(cents(100), cents(200), cents(300))).toBe(600n);
  });

  it('soustrait', () => {
    expect(subtractCents(cents(100), cents(30))).toBe(70n);
  });

  it('autorise un resultat negatif', () => {
    expect(subtractCents(cents(30), cents(100))).toBe(-70n);
  });

  it('multiplie par un nombre de jours', () => {
    expect(multiplyCents(cents(35_000), 5)).toBe(175_000n);
  });

  it('refuse un facteur decimal', () => {
    expect(() => multiplyCents(cents(100), 2.5)).toThrow();
  });

  it('refuse un facteur negatif', () => {
    expect(() => multiplyCents(cents(100), -1)).toThrow(/negatif/);
  });

  it('divise en arrondissant au superieur', () => {
    expect(divideCentsCeil(cents(100), 3)).toBe(34n);
    expect(divideCentsCeil(cents(99), 3)).toBe(33n);
    expect(divideCentsCeil(cents(100), 4)).toBe(25n);
  });

  it('refuse un diviseur invalide', () => {
    expect(() => divideCentsCeil(cents(100), 0)).toThrow();
    expect(() => divideCentsCeil(cents(100), -2)).toThrow();
    expect(() => divideCentsCeil(cents(100), 1.5)).toThrow();
  });

  it('compare deux montants', () => {
    expect(maxCents(cents(100), cents(200))).toBe(200n);
    expect(minCents(cents(100), cents(200))).toBe(100n);
  });

  it('convertit en nombre pour l affichage', () => {
    expect(toNumber(cents(1234))).toBe(1234);
  });
});

describe('applyRate', () => {
  it('calcule 12 % sans erreur d arrondi', () => {
    expect(applyRate(cents(100_000), 0.12)).toBe(12_000n);
  });

  it('calcule 7 % exactement', () => {
    // Regression : une division flottaire donnerait 7 001.
    expect(applyRate(cents(100_000), 0.07)).toBe(7_000n);
  });

  it('calcule 5.5 %', () => {
    expect(applyRate(cents(10_000), 0.055)).toBe(550n);
  });

  it('arrondit au centime superieur', () => {
    // 100 * 12.5 % = 12.5 -> 13
    expect(applyRate(cents(100), 0.125)).toBe(13n);
  });

  it('renvoie zero pour un taux nul', () => {
    expect(applyRate(cents(100_000), 0)).toBe(0n);
  });

  it('renvoie le montant pour un taux de 100 %', () => {
    expect(applyRate(cents(100_000), 1)).toBe(100_000n);
  });

  it('refuse un taux hors plage', () => {
    expect(() => applyRate(cents(100), -0.1)).toThrow();
    expect(() => applyRate(cents(100), 1.5)).toThrow();
  });
});

describe('Money', () => {
  it('associe un montant a sa devise', () => {
    const result = money(cents(35_000), 'XOF');

    expect(result.amount).toBe(35_000n);
    expect(result.currency).toBe('XOF');
  });

  it('additionne une liste de montants', () => {
    const result = sumMoney(
      [money(cents(100), 'XOF'), money(cents(250), 'XOF')],
      'XOF',
    );

    expect(result.amount).toBe(350n);
  });
});

describe('formatMoney', () => {
  it('formate le XOF sans decimales', () => {
    // Le franc CFA n'a pas de subunit : 3 500 000 s'affichent
    // « 3 500 000 XOF », pas « 35 000,00 XOF ».
    const result = formatMoney(cents(3_500_000), 'XOF');

    expect(result).not.toContain(',');
    expect(result.replaceAll(/\s/g, '')).toContain('3500000XOF');
  });

  it('formate une devise a subunit avec deux decimales', () => {
    expect(formatMoney(cents(12_345), 'EUR')).toContain(',45');
    // 12 300 centimes font bien 123,00 EUR : l'affichage doit montrer
    // la subunit plutot que de laisser croire a un arrondi.
    expect(formatMoney(cents(12_300), 'EUR')).toContain(',00');
  });

  it('gere un montant nul', () => {
    expect(formatMoney(cents(0), 'XOF')).toContain('0');
  });
});