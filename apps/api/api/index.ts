/**
 * Point d'entree de la fonction Vercel.
 *
 * Volontairement minimal : le gestionnaire reel est dans
 * `src/bootstrap/vercel-handler.ts`, donc type verifie, teste et compile
 * comme le reste du code. Un gestionnaire ecrit ici ne le serait pas,
 * et ne serait verifie qu'en production.
 */
export { vercelHandler as default } from '../src/bootstrap/vercel-handler';
