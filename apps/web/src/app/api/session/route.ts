import { NextResponse } from 'next/server';

import { ApiError, api, clearSession, writeSession } from '@/lib/api';

/**
 * Gestionnaire de session.
 *
 * ------------------------------------------------------------------------
 * C'est le SEUL endroit ou les jetons existent en clair
 * ------------------------------------------------------------------------
 * Ils sont recus ici, poses en cookie `httpOnly`, puis oublies. Le
 * navigateur ne fait que transmettre le cookie ; il ne peut pas le
 * lire, donc une injection de script ne peut pas exfiltrer la session.
 *
 * ------------------------------------------------------------------------
 * CONTRÔLE DES ENTRÉES
 * ------------------------------------------------------------------------
 * Le corps est valide avant d'atteindre l'API. Une validation
 * approximative laisserait passer des valeurs que l'API refusera — et
 * l'utilisateur verrait un message technique au lieu d'un message clair.
 */
const IDENTIFIANTS = /^(?:\+[1-9]\d{7,14}|[^\s@]+@[^\s@]+\.[^\s@]{2,})$/;

interface ConnexionBody {
  identifier?: unknown;
  password?: unknown;
}

export async function POST(request: Request) {
  let body: ConnexionBody;

  try {
    body = (await request.json()) as ConnexionBody;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  if (typeof body.identifier !== 'string' || !IDENTIFIANTS.test(body.identifier.trim())) {
    return NextResponse.json(
      {
        code: 'IDENTIFIANT_INVALIDE',
        message: 'Saisissez votre numéro de téléphone ou votre courriel.',
      },
      { status: 400 },
    );
  }

  if (typeof body.password !== 'string' || body.password.length === 0) {
    return NextResponse.json(
      { code: 'MOT_DE_PASSE_REQUIS', message: 'Mot de passe requis.' },
      { status: 400 },
    );
  }

  try {
    const session = await api<{ accessToken: string; refreshToken: string }>(
      '/auth/login',
      {
        method: 'POST',
        body: {
          identifier: body.identifier.trim(),
          password: body.password,
        },
        requireAuth: false,
      },
    );

    await writeSession(session, request);

    // ⚠️ Les jetons ne sont JAMAIS renvoyés dans le corps de la réponse.
    //
    // Ils sont posés en cookie `httpOnly`, que le navigateur ne peut pas
    // lire. Les renvoyer aussi dans le JSON annulerait tout l'intérêt du
    // cookie : le jeton redeviendrait lisible par n'importe quel script
    // de la page, donc vole par une injection.
    //
    // Le corps ne confirme que la reussite.
    return NextResponse.json({ ok: true });
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

/**
 * La deconnexion invalide la session COTE SERVEUR.
 *
 * Effacer les cookies ne suffit pas : sans cet appel, le jeton de
 * rafraichissement resterait valide cote API pendant toute sa duree de
 * vie, et la deconnexion serait purement cosmetique.
 */
export async function DELETE() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // Une session deja invalide n'est pas une erreur : le but est
    // atteint.
  } finally {
    await clearSession();
  }

  return NextResponse.json({ ok: true });
}
