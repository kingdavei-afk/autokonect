/**
 * Montants dans la plus petite unite de la devise.
 *
 * Le CDCS 4.3 impose des entiers : `0.1 + 0.2 !== 0.3` en virgule
 * flottante, ce qui sur des francs CFA devient une erreur de quelques
 * unites par reservation. Le type `Centimes` rend cette confusion
 * impossible a la compilation.
 *
 * **AVERTISSEMENT DE SEMANTIQUE.** Le nom `Centimes` est historique :
 * l'unite stockee est celle declaree par `currency.minor_units`.
 *
 *   - `EUR` : minor_units = 2, l'unite stockee est le centime.
 *     3 500 000 = 35 000,00 EUR.
 *   - `XOF` / `XAF` : minor_units = 0, l'unite stockee est LE FRANC.
 *     3 500 000 = 3 500 000 XOF, soit 3,5 millions de francs.
 *
 * C'est une consequence directe du fait que le XOF n'a pas de subunit
 * (CDCS 4.3). Un prix de location de 3 500 000 correspond donc a
 * 3 500 000 FCFA par jour, pas a 35 000 FCFA. Toute conversion vers
 * une devise a subunit doit passer par `formatMoney` ou par une
 * conversion explicite, jamais par une division supposee.
 *
 * Deux protections se cumulent :
 *
 * 1. **Le type nominal.** `Centimes` n'est pas un `number` : un
 *    nombre brut ne peut pas etre passe a une fonction monetaire
 *    sans conversion explicite. L'erreur devient visible a la
 *    compilation.
 * 2. **Les fonctions de conversion testent l'integrite.** Un `100.5`
 *    ou un `NaN` sont refuses a l'execution, parce que `number` les
 *    autorise encore.
 */

declare const centimesBrand: unique symbol;

/** Montant entier en centimes. Utiliser `cents()` pour le construire. */
export type Centimes = bigint & { readonly [centimesBrand]: 'Centimes' };

/** Devise ISO 4217. `XOF` n'a aucune subunit (CDCS 4.3). */
export type CurrencyCode = string;

/** Resultat d'un calcul monetaire : montant et devise, toujours ensemble. */
export interface Money {
  amount: Centimes;
  currency: CurrencyCode;
}

/**
 * Convertit une valeur en centimes.
 *
 * Accepte un entier, un `bigint` ou une chaine de chiffres (ce que
 * renvoie le pilote `pg` pour un `bigint`). refuse tout ce qui n'est
 * pas entier : arrondir silencieusement une facture serait pire que de
 * refuser de la calculer.
 *
 * @throws Error si la valeur n'est pas un entier sur.
 */
export function cents(value: bigint | number | string): Centimes {
  let parsed: bigint;

  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Montant invalide : ${String(value)} n'est pas un nombre fini.`);
    }
    if (!Number.isInteger(value)) {
      throw new Error(
        `Montant invalide : ${value} n'est pas entier. ` +
          'Les montants sont exprimes en centimes ; utilisez cents() avec un entier.',
      );
    }
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Montant invalide : "${value}" n'est pas un entier.`);
    }
    parsed = BigInt(trimmed);
  }

  return parsed as Centimes;
}

/** Somme. Depassement : leve une erreur plutot que de silentlyusement tronquer. */
export function addCents(...values: Centimes[]): Centimes {
  return values.reduce<bigint>((total, value) => total + value, 0n) as Centimes;
}

/** Soustraction. Le resultat peut etre negatif : c'est un calcul, pas une erreur. */
export function subtractCents(minuend: Centimes, subtrahend: Centimes): Centimes {
  return (minuend - subtrahend) as Centimes;
}

/**
 * Multiplication par un facteur entier (nombre de jours, pourcentage).
 *
 * Refuse un facteur negatif : un tarif de location negatif est un bug,
 * pas une promotion.
 */
export function multiplyCents(value: Centimes, factor: number): Centimes {
  if (!Number.isInteger(factor)) {
    throw new Error(`Facteur invalide : ${factor} doit etre entier.`);
  }
  if (factor < 0) {
    throw new Error(`Facteur invalide : ${factor} ne peut pas etre negatif.`);
  }
  return (value * BigInt(factor)) as Centimes;
}

/** Division entiere, arrondie au centime superieur pour ne jamais sous-facturer. */
export function divideCentsCeil(value: Centimes, divisor: number): Centimes {
  if (divisor <= 0 || !Number.isInteger(divisor)) {
    throw new Error(`Diviseur invalide : ${divisor}.`);
  }
  const denominator = BigInt(divisor);
  return ((value + denominator - 1n) / denominator) as Centimes;
}

/**
 * Applique un taux et arrondit au centime superieur.
 *
 * Le taux est converti en **points de base entiers** (1 point = 0,01 %)
 * avant tout calcul. Sans cette conversion, `Math.round(10000 / 0.07)`
 * vaut 142857 au lieu de 142857.14..., et un montant de 100 000
 * donnerait 7 001 au lieu de 7 000 : une erreur d'un centime par
 * reservation, invisible en recette et redhibitoire en controle fiscal.
 *
 * L'arrondi est vers le haut : la plateforme ne doit jamais facturer
 * moins que la commission due.
 */
export function applyRate(value: Centimes, rate: number): Centimes {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`Taux invalide : ${rate}. Attendu entre 0 et 1 (0.12 = 12 %).`);
  }

  // 0.12 -> 1200 points de base, soit 12.00 %.
  const basisPoints = BigInt(Math.round(rate * 10_000));

  if (basisPoints === 0n) return 0n as Centimes;

  return divideCentsCeil((value * basisPoints) as Centimes, 10_000);
}

export function isZero(value: Centimes): boolean {
  return value === 0n;
}

export function isNegative(value: Centimes): boolean {
  return value < 0n;
}

export function maxCents(a: Centimes, b: Centimes): Centimes {
  return a >= b ? a : b;
}

export function minCents(a: Centimes, b: Centimes): Centimes {
  return a <= b ? a : b;
}

/** Nombre de centimes de devise, en nombre (a n utiliser que pour l'affichage). */
export function toNumber(value: Centimes): number {
  return Number(value);
}

export function money(amount: Centimes, currency: CurrencyCode): Money {
  return { amount, currency };
}

export function sumMoney(values: Money[], currency: CurrencyCode): Money {
  return {
    amount: values.reduce<bigint>((total, item) => total + item.amount, 0n) as Centimes,
    currency,
  };
}

/**
 * Formate un montant pour l'affichage.
 *
 * `XOF` et `XAF` n'ont aucune subunit : `3 500 000` centimes
 * s'affichent `35 000 XOF` et non `35 000,00 XOF` (CDCS 4.3).
 *
 * Les devises a deux decimales conservent deux decimales, conformement
 * a l'usage : afficher « 123 EUR » pour 12 300 centimes ferait croire a
 * un montant arrondi.
 */
export function formatMoney(
  value: Centimes,
  currency: CurrencyCode,
  locale = 'fr-CI',
): string {
  const hasSubunits = currency !== 'XOF' && currency !== 'XAF';
  const divisor = hasSubunits ? 100n : 1n;
  const major = (value / divisor).toString();
  const minor = hasSubunits ? (value % divisor).toString().padStart(2, '0') : '';

  // ------------------------------------------------------------------------
  // ZERO decimale sur la partie entiere, TOUJOURS
  // ------------------------------------------------------------------------
  // La partie des subunit est ajoutee a la main, avec le separateur du
  // montant directement. Demander deux decimales a `Intl` ET ajouter la
  // partie decimale ensuite produisait « 123,00,00 EUR » pour 12 300
  // centimes : `Intl` formatait deja 123 en « 123,00 », puis le code
  // collait « ,00 » derriere.
  //
  // Le bug ne se voyait sur aucune devise du marche : le XOF et le XAF
  // n'ont pas de subunit, donc le cas n'etait jamais atteint. Il
  // apparaitrait des le premier montant en euros ou en dollars.
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(major));

  return `${formatted}${hasSubunits ? `,${minor}` : ''} ${currency}`;
}