/**
 * Formatage des montants pour l'affichage.
 *
 * ------------------------------------------------------------------------
 * LE XOF N'A PAS DE SUBUNIT
 * ------------------------------------------------------------------------
 * `3 500 000` en francs CFA signifie TROIS MILLIONS CINQ CENTS MILLE
 * francs. Pas 35 000. La divise par cent — reflexe acquis sur les
 * sites europeens — afficherait un prix FAUX, vingt fois trop bas.
 *
 * C'est le type d'erreur le plus grave possible sur une page de prix :
 * l'utilisateur voit un chiffre believable et faux.
 *
 * La regle vient de `currency.minor_units` dans la base, pas d'une
 * convention de code. Toute devise a deux decimales garde ses deux
 * decimales, parce que « 123 EUR » pour 12 300 centimes ferait croire
 * a un arrondi.
 */

/** Devises sans subunit : l'unite stockee EST la devise. */
const SANS_SUBUNIT = new Set(['XOF', 'XAF', 'JPY', 'GNF']);

/**
 * Convertit une valeur en `bigint`, ou refuse.
 *
 * ------------------------------------------------------------------------
 * POURQUOI NE PAS VALEUR PAR DEFAUT A ZERO
 * ------------------------------------------------------------------------
 * Un montant manquant affichait « Caution 0 XOF ». L'utilisateur lisait
 * « aucune caution demandée » et concluait que la caution etait
 * gratuite. C'est une AFFIRMATION FAUSSE sur le prix, produite par un
 * simple champ absent — et rien ne l'indiquait.
 *
 * Un montant absent doit donc faire echouer le rendu plutot que de
 * produire un chiffre. Une page cassee se remarque ; une caution
 * affichee a zero, non.
 */
function versEntier(brut: string | number | bigint | undefined | null): bigint {
  if (brut === undefined || brut === null || brut === '') {
    throw new Error(
      'Montant absent de la reponse de l API : refusing de l afficher. ' +
        'Afficher 0 ferait croire a un montant gratuit.',
    );
  }

  try {
    return typeof brut === 'string' ? BigInt(brut) : BigInt(brut);
  } catch {
    throw new Error(`Montant illisible : ${JSON.stringify(brut)}`);
  }
}

export interface MontantAffiche {
  /** Partie entiere, formatee. */
  entier: string;
  /** Partie decimale, sans separateur. Vide si sans subunit. */
  decimal: string;
  /** Devise. */
  devise: string;
  /** Les deux parties assemblees, pretes a afficher. */
  complet: string;
}

export function formatMontant(
  brut: string | number | bigint,
  devise = 'XOF',
  locale = 'fr-CI',
): MontantAffiche {
  const valeur = versEntier(brut);
  const sansSubunit = SANS_SUBUNIT.has(devise);
  const diviseur = sansSubunit ? 1n : 100n;

  // La division se fait en BigInt : un BigInt perdu en `number`
  // deborderait a 2^53, et un total de location peut legitement
  // depasser cette borne.
  const entier = valeur / diviseur;
  const decimal = sansSubunit ? '' : (valeur % diviseur).toString().padStart(2, '0');

  const entierFormate = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(entier));

  return {
    entier: entierFormate,
    decimal,
    devise,
    complet: `${entierFormate}${sansSubunit ? '' : `,${decimal}`} ${devise}`,
  };
}

/** Montant compact pour les listes : 3,5 M au lieu de 3 500 000. */
export function formatCompact(
  brut: string | number | bigint,
  devise = 'XOF',
): string {
  const valeur = versEntier(brut);
  const sansSubunit = SANS_SUBUNIT.has(devise);
  const diviseur = sansSubunit ? 1n : 100n;
  const entier = Number(valeur / diviseur);

  // En dessous d'un million, le nombre entier complet reste lisible.
  if (entier < 1_000_000) {
    return `${new Intl.NumberFormat('fr-CI').format(entier)}${sansSubunit ? '' : `,${(valeur % diviseur).toString().padStart(2, '0')}`} ${devise}`;
  }

  return `${new Intl.NumberFormat('fr-CI', {
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(entier)} ${devise}`;
}
