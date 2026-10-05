import { NextResponse } from 'next/server';

import { ApiError, api, writeSession } from '@/lib/api';

/**
 * Inscription.
 *
 * ⚠️ Le code OTP n'est JAMAIS renvoye a l'appelant. Il est envoye par
 * SMS a la personne qui detient le telephone, et le journaliser ou le
 * retransmettre reviendrait a permettre de verifier un compte sans
 * posseder le numero.
 *
 * La reponse ne contient donc que l'etape suivante : « verifiez votre
 * telephone ». Le client affichera ensuite le champ de saisie du code.
 */
const TELEPHONE = /^\+[1-9]\d{7,14}$/;
const COURRIEL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Corps {
  email?: unknown;
  phone?: unknown;
  password?: unknown;
  role?: unknown;
  acceptTerms?: unknown;
}

export async function POST(request: Request) {
  let corps: Corps;

  try {
    corps = (await request.json()) as Corps;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  // La validation est faite ICI, et non seulement par l'API.
  //
  // L'API repond `400 Donnees invalides.` sans dire quel champ est en
  // faute : un formulaire qui affiche ce message ne peut pas guider
  // l'utilisateur. Valider ici permet de nommer le probleme.
  if (typeof corps.phone !== 'string' || !TELEPHONE.test(corps.phone.trim())) {
    return NextResponse.json(
      {
        code: 'TELEPHONE_INVALIDE',
        message: 'Numéro invalide. Format attendu : +225 07 00 00 00 00.',
      },
      { status: 400 },
    );
  }

  if (typeof corps.email !== 'string' || !COURRIEL.test(corps.email.trim())) {
    return NextResponse.json(
      { code: 'COURRIEL_INVALIDE', message: 'Adresse électronique invalide.' },
      { status: 400 },
    );
  }

  if (typeof corps.password !== 'string' || corps.password.length < 12) {
    return NextResponse.json(
      {
        code: 'MOT_DE_PASSE_FAIBLE',
        message: 'Le mot de passe doit comporter au moins 12 caractères.',
      },
      { status: 400 },
    );
  }

  if (corps.acceptTerms !== true) {
    return NextResponse.json(
      {
        code: 'CONDITIONS_NON_ACCEPTEES',
        message: "Les conditions d'utilisation doivent être acceptées.",
      },
      { status: 400 },
    );
  }

  try {
    await api('/auth/register', {
      method: 'POST',
      body: {
        email: corps.email.trim(),
        phone: corps.phone.trim(),
        password: corps.password,
        // Un client ne s'attribue jamais `admin` : meme si le
        // navigateur l'envoyait, il serait ici ramene a `client`.
        role: corps.role === 'owner' ? 'owner' : 'client',
        acceptTerms: true,
      },
      requireAuth: false,
    });

    return NextResponse.json({ ok: true, nextStep: 'verify_phone' });
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
 * Verification du numero par code OTP.
 *
 * Route distincte de l'inscription : le code est une seconde etape,
 * avec un etat different et un message different.
 */
export async function PUT(request: Request) {
  let corps: { phone?: unknown; code?: unknown };

  try {
    corps = (await request.json()) as typeof corps;
  } catch {
    return NextResponse.json(
      { code: 'REQUETE_INVALIDE', message: 'Requête illisible.' },
      { status: 400 },
    );
  }

  if (typeof corps.phone !== 'string' || !TELEPHONE.test(corps.phone.trim())) {
    return NextResponse.json(
      { code: 'TELEPHONE_INVALIDE', message: 'Numéro invalide.' },
      { status: 400 },
    );
  }

  if (typeof corps.code !== 'string' || !/^\d{6}$/.test(corps.code)) {
    return NextResponse.json(
      { code: 'CODE_INVALIDE', message: 'Le code comporte 6 chiffres.' },
      { status: 400 },
    );
  }

  try {
    const session = await api<{ accessToken: string; refreshToken: string }>(
      '/auth/verify-phone',
      {
        method: 'POST',
        body: { phone: corps.phone.trim(), code: corps.code },
        requireAuth: false,
      },
    );

    // La verification CONNECTE : inutile de redemander le mot de passe
    // a quelqu'un dont le numero vient d etre prouve.
    //
    // Les jetons ne sont pas renvoyes dans le corps — ils vont en
    // cookie `httpOnly`. Voir la note dans `/api/session`.
    await writeSession(session, request);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}
