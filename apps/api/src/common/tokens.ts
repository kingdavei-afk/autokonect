/**
 * Tokens d'injection.
 *
 * Isoles dans un fichier sans aucun import : cela evite un cycle
 * d'import entre le module de configuration et le logger qui en depend.
 * Un token defini dans un fichier circulaire vaut `undefined` au moment
 * de la decoration des parametres, ce qui produit une erreur d'injection
 * tres difficile a diagnostiquer.
 */

/** Configuration applicative validee et figee au demarrage. */
export const APP_CONFIG = 'APP_CONFIG';

/** Instance Kysely (pool de connexions). */
export const DATABASE = 'DATABASE';

/** Marqueur : route accessible sans jeton. */
export const IS_PUBLIC_KEY = 'isPublic';