import { NextResponse } from 'next/server';

import { ApiError, api, readSession } from '@/lib/api';

/**
 * Decision de publication.
 *
 * Le role `admin` n'est PAS verifie ici : seul l'API peut le faire de
 * façon fiable, et c'est elle qui l'applique. Cette route se contente de
 * transmettre.
 *
 * Refuser sans motif produirait une decision inexploitable pour le
 * propriétaire : il ne saurait pas quoi corriger. Le motif est donc
 * exige ici, et l'API l'exige aussi.
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

  let corps: { decision?: unknown; reason?: unknown };

  try {
    corps = (await request.json()) as typeof corps;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  if (corps.decision !== 'approve' && corps.decision !== 'reject') {
    return NextResponse.json(
      { code: 'DECISION_INVALIDE', message: 'Décision invalide.' },
      { status: 400 },
    );
  }

  if (corps.decision === 'reject' && (typeof corps.reason !== 'string' || corps.reason.trim().length < 5)) {
    return NextResponse.json(
      {
        code: 'MOTIF_REQUIS',
        message: 'Le refus doit être motivé (5 caractères minimum).',
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await api(`/admin/vehicles/${id}/decision`, {
        method: 'POST',
        body: {
          decision: corps.decision,
          reason: typeof corps.reason === 'string' ? corps.reason.trim() : undefined,
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
