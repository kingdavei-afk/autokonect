import { NextResponse } from 'next/server';

import { ApiError, api, readSession } from '@/lib/api';

/**
 * Annulation d'une reservation.
 *
 * Le motif est obligatoire et verifie ici : il apparait sur la facture
 * et dans le dossier de litige. Une annulation sans motif laisse une
 * trace inexploitable.
 *
 * `by` n'est pas transmis depuis le navigateur. Il est determine par le
 * serveur : un client ne peut pas annuler au nom du fournisseur, et
 * faire passer le choix par le formulaire reviendrait a lui offrir
 * exactement cette possibilite.
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

  let corps: { reason?: unknown; expectedVersion?: unknown };

  try {
    corps = (await request.json()) as typeof corps;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  if (typeof corps.reason !== 'string' || corps.reason.trim().length < 3) {
    return NextResponse.json(
      {
        code: 'MOTIF_REQUIS',
        message: 'Indiquez un motif d’annulation (3 caractères minimum).',
      },
      { status: 400 },
    );
  }

  if (typeof corps.expectedVersion !== 'number') {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Version manquante.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await api(`/bookings/${id}/cancel`, {
        method: 'POST',
        body: {
          // L'API croise cette valeur avec le role reel de l'appelant
          // et refuse la contradiction ; envoyer `provider` systematiquement
          // ferait echouer l'annulation d'un client.
          by: 'client',
          reason: corps.reason.trim(),
          expectedVersion: corps.expectedVersion,
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
