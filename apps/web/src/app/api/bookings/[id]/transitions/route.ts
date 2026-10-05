import { NextResponse } from 'next/server';

import { ApiError, api, readSession } from '@/lib/api';

/**
 * Transition d'etat d'une reservation.
 *
 * `expectedVersion` est transmis tel quel : c'est le verrou qui empeche
 * deux agents d'ecraser la meme reservation, et il ne doit jamais etre
 * « corrige » cote client pour faire passer la requete. Une version
 * perimee doit echouer, puis l'utilisateur recharge.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json(
      { code: 'NON_AUTHENTIFIE', message: 'Connectez-vous.' },
      { status: 401 },
    );
  }

  const { id } = await params;

  let corps: { to?: unknown; expectedVersion?: unknown; reason?: unknown };

  try {
    corps = (await request.json()) as typeof corps;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  if (typeof corps.to !== 'string' || typeof corps.expectedVersion !== 'number') {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Transition incomplète.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await api(`/bookings/${id}/transitions`, {
        method: 'POST',
        body: {
          to: corps.to,
          expectedVersion: corps.expectedVersion,
          reason: typeof corps.reason === 'string' ? corps.reason : undefined,
        },
      }),
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { code: error.code, message: error.message, details: error.details },
        { status: error.status },
      );
    }
    throw error;
  }
}
