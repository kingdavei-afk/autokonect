/**
 * Libelles et couleurs des statuts.
 *
 * Un statut brut de la base (`awaiting_payment`) n'est pas acceptable
 * dans une interface : il parle a la machine, pas a l'utilisateur.
 *
 * Le mapping est ici et nulle part ailleurs, pour que la meme chose ne
 * soit pas traduite de deux facons selon la page.
 */

export const LIBELLES_STATUT_RESERVATION: Record<string, string> = {
  draft: 'Brouillon',
  awaiting_payment: 'En attente de paiement',
  paid: 'Payée',
  in_progress: 'En cours',
  late_return: 'Restitution tardive',
  completed: 'Terminée',
  disputed: 'Litige en cours',
  cancelled_client: 'Annulée par le client',
  cancelled_provider: 'Annulée par le fournisseur',
  expired: 'Expirée',
  resolved_client: 'Litige résolu — client',
  resolved_provider: 'Litige résolu — fournisseur',
  resolved_split: 'Litige résolu — partage',
  closed: 'Clôturée',
};

/**
 * Couleurs par statut.
 *
 * `vert` = la reservation se passe bien. `orange` = une action du
 * client est attendue. `rouge` = perte d'argent ou blocage.
 *
 * `awaiting_payment` est en ORANGE et non en gris : c'est l'etat ou le
 * client doit AGIR, et une reservation en attente est une reservation
 * qui se perd si elle reste grise.
 */
const COULEURS: Record<string, string> = {
  draft: 'bg-encre-100 text-encre-700',
  awaiting_payment: 'bg-marque-100 text-marque-800',
  paid: 'bg-emerald-100 text-emerald-800',
  in_progress: 'bg-sky-100 text-sky-800',
  late_return: 'bg-marque-100 text-marque-800',
  completed: 'bg-emerald-100 text-emerald-800',
  disputed: 'bg-red-100 text-red-800',
  cancelled_client: 'bg-encre-100 text-encre-600',
  cancelled_provider: 'bg-encre-100 text-encre-600',
  expired: 'bg-encre-100 text-encre-500',
  resolved_client: 'bg-violet-100 text-violet-800',
  resolved_provider: 'bg-violet-100 text-violet-800',
  resolved_split: 'bg-violet-100 text-violet-800',
  closed: 'bg-encre-100 text-encre-600',
};

export function libelleStatut(statut: string): string {
  return LIBELLES_STATUT_RESERVATION[statut] ?? statut;
}

export function couleurStatut(statut: string): string {
  return COULEURS[statut] ?? 'bg-encre-100 text-encre-700';
}

/** Libelle du role, en francais. */
export function libelleRole(role: string): string {
  switch (role) {
    case 'admin':
      return 'Administrateur';
    case 'owner':
      return 'Propriétaire';
    case 'driver':
      return 'Chauffeur';
    default:
      return 'Client';
  }
}

/**
 * Date lisible.
 *
 * Le fuseau est force a `Africa/Abidjan` : le serveur peut tourner en
 * UTC, et afficher « 15/10 08:00 » pour une reservation de 15 h locale
 * serait une erreur dereservation, pas un detail d'affichage.
 */
export function formatDate(iso: string | Date): string {
  return new Intl.DateTimeFormat('fr-CI', {
    dateStyle: 'medium',
    timeZone: 'Africa/Abidjan',
  }).format(new Date(iso));
}

export function formatDateHeure(iso: string | Date): string {
  return new Intl.DateTimeFormat('fr-CI', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Abidjan',
  }).format(new Date(iso));
}
