'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Etape = 'connexion' | 'inscription' | 'verification';

interface Erreur {
  code?: string;
  message?: string;
}

export function FormulaireConnexion() {
  const router = useRouter();
  const [etape, setEtape] = useState<Etape>('connexion');
  const [erreur, setErreur] = useState<Erreur | null>(null);
  const [enCours, setEnCours] = useState(false);

  const [identifiant, setIdentifiant] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [email, setEmail] = useState('');
  const [telephone, setTelephone] = useState('');
  const [code, setCode] = useState('');
  const [role, setRole] = useState<'client' | 'owner'>('client');

  async function envoyer(url: string, corps: unknown) {
    setEnCours(true);
    setErreur(null);

    try {
      const reponse = await fetch(url, {
        method: url === '/api/auth' ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      });

      const donnees = (await reponse.json().catch(() => ({}))) as Erreur & {
        nextStep?: string;
      };

      if (!reponse.ok) {
        setErreur({ code: donnees.code, message: donnees.message });
        return null;
      }

      return donnees;
    } catch {
      setErreur({
        message: 'Le service est injoignable. Vérifiez votre connexion.',
      });
      return null;
    } finally {
      setEnCours(false);
    }
  }

  async function seConnecter(event: React.FormEvent) {
    event.preventDefault();

    const resultat = await envoyer('/api/session', { identifier: identifiant, password: motDePasse });

    if (resultat) {
      router.push('/');
      router.refresh();
    }
  }

  async function sInscrire(event: React.FormEvent) {
    event.preventDefault();

    const resultat = await envoyer('/api/auth', {
      email,
      phone: telephone,
      password: motDePasse,
      role,
      acceptTerms: true,
    });

    if (resultat) {
      setEtape('verification');
    }
  }

  async function verifier(event: React.FormEvent) {
    event.preventDefault();

    const resultat = await envoyer('/api/auth', { phone: telephone, code });

    if (resultat) {
      router.push('/');
      router.refresh();
    }
  }

  // ------------------------------------------------------------------
  // Verification
  // ------------------------------------------------------------------
  if (etape === 'verification') {
    return (
      <form onSubmit={verifier} className="carte space-y-5 p-6">
        <div>
          <h2 className="text-lg font-semibold text-encre-900">Vérifiez votre téléphone</h2>
          <p className="mt-1 text-sm text-encre-600">
            Un code à 6 chiffres a été envoyé au {telephone}.
          </p>
        </div>

        {erreur && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{erreur.message}</p>
        )}

        <div>
          <label htmlFor="code" className="etiquette">
            Code de vérification
          </label>
          <input
            id="code"
            className="champ tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        </div>

        <button type="submit" className="bouton-primaire w-full" disabled={enCours || code.length !== 6}>
          {enCours ? 'Vérification…' : 'Vérifier'}
        </button>
      </form>
    );
  }

  // ------------------------------------------------------------------
  // Connexion / inscription
  // ------------------------------------------------------------------
  const inscription = etape === 'inscription';

  return (
    <form onSubmit={inscription ? sInscrire : seConnecter} className="carte space-y-5 p-6">
      <div>
        <h2 className="text-lg font-semibold text-encre-900">
          {inscription ? 'Créer un compte' : 'Connexion'}
        </h2>
        <p className="mt-1 text-sm text-encre-600">
          {inscription
            ? 'Un compte est nécessaire pour réserver et pour être contacté.'
            : 'Réservations, cautions et historique : tout au même endroit.'}
        </p>
      </div>

      {erreur && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{erreur.message}</p>
      )}

      {inscription ? (
        <>
          <div>
            <label htmlFor="telephone" className="etiquette">
              Téléphone
            </label>
            <input
              id="telephone"
              className="champ"
              type="tel"
              placeholder="+225 07 00 00 00 00"
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
              required
            />
            <p className="mt-1 text-xs text-encre-500">
              C’est par SMS que vous recevrez les confirmations.
            </p>
          </div>

          <div>
            <label htmlFor="email" className="etiquette">
              Adresse électronique
            </label>
            <input
              id="email"
              className="champ"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <fieldset>
            <legend className="etiquette">Je souhaite</legend>
            <div className="flex gap-2">
              {(
                [
                  ['client', 'Louer'],
                  ['owner', 'Proposer un véhicule'],
                ] as const
              ).map(([valeur, libelle]) => (
                <label
                  key={valeur}
                  className={`flex flex-1 cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                    role === valeur
                      ? 'border-marque-600 bg-marque-50 text-marque-800'
                      : 'border-encre-300 text-encre-600 hover:bg-encre-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    className="sr-only"
                    value={valeur}
                    checked={role === valeur}
                    onChange={() => setRole(valeur)}
                  />
                  {libelle}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <div>
          <label htmlFor="identifiant" className="etiquette">
            Téléphone ou courriel
          </label>
          <input
            id="identifiant"
            className="champ"
            autoComplete="username"
            value={identifiant}
            onChange={(e) => setIdentifiant(e.target.value)}
            required
          />
        </div>
      )}

      <div>
        <label htmlFor="motDePasse" className="etiquette">
          Mot de passe
        </label>
        <input
          id="motDePasse"
          className="champ"
          type="password"
          autoComplete={inscription ? 'new-password' : 'current-password'}
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
          required
        />
        {inscription && (
          <p className="mt-1 text-xs text-encre-500">12 caractères minimum.</p>
        )}
      </div>

      <button type="submit" className="bouton-primaire w-full" disabled={enCours}>
        {enCours
          ? inscription
            ? 'Création…'
            : 'Connexion…'
          : inscription
            ? 'Créer mon compte'
            : 'Se connecter'}
      </button>

      <button
        type="button"
        onClick={() => {
          setEtape(inscription ? 'connexion' : 'inscription');
          setErreur(null);
        }}
        className="w-full text-center text-sm font-medium text-marque-700 hover:underline"
      >
        {inscription ? 'J’ai déjà un compte' : 'Créer un compte'}
      </button>
    </form>
  );
}
