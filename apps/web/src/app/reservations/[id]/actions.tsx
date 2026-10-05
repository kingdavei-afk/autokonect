'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { libelleStatut } from '@/lib/format';

/**
 * Actions possibles sur une reservation.
 *
 * Les actions proposees viennent de l'API (`allowedTransitions`), pas
 * d'une regle reecrite ici.
 *
 * Dupliquer la machine a etats dans le front serait la source de
 * divergence la plus facile a creer : l'application afficherait un
 * bouton « Annuler » que le serveur refuse, ou cacherait une action
 * possible. Le serveur reste l'autorite, le client ne fait qu'afficher
 * ce qu'il a dit.
 *
 * Le bouton « Annuler » est distinct des autres transitions : il exige
 * un motif, qui a des effets financiers.
 */
export function ActionsReservation({
  id,
  version,
  statut,
  transitions,
}: {
  id: string;
  version: number;
  statut: string;
  transitions: string[];
}) {
  const router = useRouter();
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [motif, setMotif] = useState('');

  const annulationPossible = transitions.includes('cancelled_client');
  const autres = transitions.filter((t) => !t.startsWith('cancelled'));

  async function transition(cible: string) {
    setEnCours(cible);
    setErreur(null);

    try {
      const reponse = await fetch(`/api/bookings/${id}/transitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: cible, expectedVersion: version }),
      });

      const donnees = (await reponse.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
        details?: { allowed?: string[]; currentVersion?: number };
      };

      if (!reponse.ok) {
        // Un conflit de version n'est pas une erreur fatale : il suffit
        // de recharger. Le dire evite que l'utilisateur conclude a un
        // bug alors que sa session etait simplementPerimee.
        setErreur(
          donnees.code === 'VERSION_CONFLIT'
            ? 'Cette réservation vient d’être modifiée. Actualisation…'
            : (donnees.message ?? 'Action impossible.'),
        );

        if (donnees.code === 'VERSION_CONFLIT') {
          setTimeout(() => router.refresh(), 1200);
        }
        return;
      }

      router.refresh();
    } finally {
      setEnCours(null);
    }
  }

  async function annuler() {
    if (motif.trim().length < 3) {
      setErreur('Indiquez un motif d’annulation (3 caractères minimum).');
      return;
    }

    setEnCours('cancelled_client');
    setErreur(null);

    try {
      const reponse = await fetch(`/api/bookings/${id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          by: 'client',
          reason: motif.trim(),
          expectedVersion: version,
        }),
      });

      const donnees = (await reponse.json().catch(() => ({}))) as { message?: string };

      if (!reponse.ok) {
        setErreur(donnees.message ?? 'Annulation impossible.');
        return;
      }

      router.refresh();
    } finally {
      setEnCours(null);
    }
  }

  if (transitions.length === 0) {
    return (
      <p className="carte p-4 text-center text-sm text-encre-500">
        Cette réservation est close : aucune action n’est possible.
        {statut === 'closed' && ' Conservez la référence en cas de litige.'}
      </p>
    );
  }

  return (
    <div className="carte space-y-4 p-6">
      <h2 className="font-semibold text-encre-900">Actions</h2>

      {erreur && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{erreur}</p>
      )}

      {autres.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {autres.map((cible) => (
            <button
              key={cible}
              type="button"
              onClick={() => transition(cible)}
              disabled={enCours !== null}
              className="bouton-secondaire"
            >
              {enCours === cible ? '…' : libelleStatut(cible)}
            </button>
          ))}
        </div>
      )}

      {annulationPossible && (
        <div className="border-t border-encre-100 pt-4">
          <label htmlFor="motif" className="etiquette">
            Annuler cette réservation
          </label>
          <textarea
            id="motif"
            className="champ min-h-16 resize-y"
            maxLength={500}
            placeholder="Motif de l’annulation"
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
          />
          <button
            type="button"
            onClick={annuler}
            disabled={enCours !== null}
            className="bouton-secondaire mt-2 border-red-300 text-red-700 hover:bg-red-50"
          >
            {enCours === 'cancelled_client' ? 'Annulation…' : 'Confirmer l’annulation'}
          </button>
          <p className="mt-2 text-xs text-encre-500">
            L’annulation est définitive. Selon les conditions, des frais
            peuvent s’appliquer.
          </p>
        </div>
      )}
    </div>
  );
}
