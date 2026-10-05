/**
 * Projections de la base vers les contrats publics.
 *
 * ------------------------------------------------------------------------
 * MONTANTS : LE XOF N'A PAS DE SUBUNIT
 * ------------------------------------------------------------------------
 * Les montants sont rendus en `bigint`, jamais en `number`. Une location
 * totale peut depasser 2^53 : au-dela, un `number` perd les unites, et
 * l'erreur est invisible — le chiffre affiche reste plausible.
 *
 * ------------------------------------------------------------------------
 * LE MONTANT EST CELUI DE LA RESERVATION, JAMAIS CELUI DU CLIENT
 * ------------------------------------------------------------------------
 * `toPaymentIntent` ne recoit aucun montant : il ne fait que le lire sur
 * la ligne du paiement. Une fonction de projection qui acceptait un
 * montantVENANTD'AILLEURS ouvrirait la porte a afficher un prix que la
 * base n'a pas enregistre. L'absence du parametre est la protection.
 */

import type { PaymentIntentOutput } from '@adkcars/contracts';

import type { PaymentRow } from './payment.types';

/**
 * Convertit un montant stocke en chaine vers la sortie publique.
 *
 * La chaine reste une chaine : le contrat `moneyOutputSchema` manipule
 * des `bigint` via une transformation Zod cote validation. Conserver la
 * forme textuelle jusqu'a la validation evite un aller-retour par
 * `BigInt` sur chaque ligne d'une liste.
 */
function montant(brut: string): string {
  // Une chaine vide ou non numerique ne doit pas produire « NaN » affiche
  // au client. `BigInt` echouerait ici, ce qui est correct : mieux vaut
  // une erreur qu'un montant affichable et faux.
  BigInt(brut);
  return brut;
}

export function toPaymentIntent(
  row: PaymentRow,
  booking: { reference: string; status: string },
): PaymentIntentOutput {
  return {
    id: row.id,
    bookingId: row.booking_id,
    bookingReference: booking.reference,
    status: row.status,
    method: row.method,
    kind: row.kind,
    amount: montant(row.amount),
    currencyCode: row.currency_code,
    providerKey: row.provider_key,
    externalRef: row.external_ref,
    // L'instruction client est reconstruite a partir de l'etat, pas
    // stockee : elle expires, et une instruction perimee affichee au
    // client le renverrait vers un paiement qui n'aboutira pas.
    instructions: instructionsFor(row),
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
    createdAt: (row.created_at ?? new Date()).toISOString(),
    updatedAt: (row.updated_at ?? new Date()).toISOString(),
  };
}

/**
 * Ce que le client doit faire, deduit du statut.
 *
 * Un paiement `paid` n'affiche aucune instruction : il est terminé.
 * Afficher « validez votre paiement » sur un paiement encaissé est le
 * genre d'ecran qui transforme un client satisfait en client qui reclique
 * — et reclique, donc paie deux fois.
 */
function instructionsFor(
  row: PaymentRow,
): PaymentIntentOutput['instructions'] | undefined {
  if (row.status !== 'pending' && row.status !== 'authorized') {
    return undefined;
  }

  if (row.method === 'cash' || row.method === 'transfer') {
    return { kind: 'none', value: '' };
  }

  if (!row.external_ref) {
    // Le prestataire n'a pas encore rendu de reference : il n'y a rien a
    // afficher. Un ecran « en attente » sans rien a faire est correct ;
    // un ecran avec une valeur vide ne l'est pas.
    return undefined;
  }

  return {
    kind: row.method === 'card' ? 'redirect_url' : 'ussd_code',
    value: row.method === 'card' ? `/paiement/${row.id}` : `*155#${row.external_ref}`,
  };
}

/**
 * Ligne de reservation JOINtee, pour la liste des paiements d'un client.
 */
export function toBookingReference(row: { reference: string; status: string }): {
  reference: string;
  status: string;
} {
  return { reference: row.reference, status: row.status };
}
