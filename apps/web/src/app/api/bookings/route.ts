import { NextResponse } from 'next/server';

import { ApiError, api, readSession } from '@/lib/api';

/**
 * Creation d'une reservation.
 *
 * Passe par le serveur : le jeton reste dans un cookie `httpOnly`, et le
 * navigateur n'a jamais a le connaitre.
 *
 * Les dates sont re-construites ici. Recevoir une chaine et la
 * transmettre telle quelle laisserait passer une date fantaisiste que
 * seule la base finirait par refuser — avec un message technique.
 */
export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json(
      { code: 'NON_AUTHENTIFIE', message: 'Connectez-vous pour réserver.' },
      { status: 401 },
    );
  }

  let corps: {
    vehicleId?: unknown;
    startAt?: unknown;
    endAt?: unknown;
    customerNotes?: unknown;
    isOneWay?: unknown;
  };

  try {
    corps = (await request.json()) as typeof corps;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  if (typeof corps.vehicleId !== 'string') {
    return NextResponse.json(
      { code: 'VEHICULE_REQUIS', message: 'Véhicule manquant.' },
      { status: 400 },
    );
  }

  for (const champ of ['startAt', 'endAt'] as const) {
    const valeur = corps[champ];
    if (typeof valeur !== 'string' || Number.isNaN(Date.parse(valeur))) {
      return NextResponse.json(
        { code: 'DATE_INVALIDE', message: 'Dates de location invalides.' },
        { status: 400 },
      );
    }
  }

  try {
    const reservation = await api<{ id: string; reference: string }>('/bookings', {
      method: 'POST',
      body: {
        vehicleId: corps.vehicleId,
        startAt: new Date(corps.startAt as string).toISOString(),
        endAt: new Date(corps.endAt as string).toISOString(),
        isOneWay: corps.isOneWay === true,
        customerNotes:
          typeof corps.customerNotes === 'string' && corps.customerNotes.trim()
            ? corps.customerNotes.trim()
            : undefined,
      },
    });

    return NextResponse.json(reservation);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
