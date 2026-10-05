'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Decision de publication.
 *
 * Le bouton « Publier » est DESACTIVE tant que la base signale des
 * points bloquants.
 *
 * Ce n'est qu'un confort d'affichage : l'API refuse elle-meme la
 * publication incomplete. Mais un bouton actif qui echoue ensuite
 * ressemblerait a un bug, et l'utilisateur comprendrait mal que la
 * regle existe.
 */
export function DecisionAdmin({
  id,
  statut,
  pret,
}: {
  id: string;
  statut: string;
  pret: boolean;
}) {
  const router = useRouter();
  const [enCours, setEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [motif, setMotif] = useState('');

  const termine = statut === 'published' || statut === 'rejected';

  async function decider(decision: 'approve' | 'reject') {
    if (decision === 'reject' && motif.trim().length < 5) {
      setErreur('Indiquez le motif du refus : le propriétaire doit savoir quoi corriger.');
      return;
    }

    setEnCours(decision);
    setErreur(null);

    try {
      const reponse = await fetch(`/api/admin/vehicules/${id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, reason: motif.trim() || undefined }),
      });

      const donnees = (await reponse.json().catch(() => ({}))) as { message?: string };

      if (!reponse.ok) {
        setErreur(donnees.message ?? 'Décision impossible.');
        return;
      }

      router.refresh();
    } finally {
      setEnCours(null);
    }
  }

  if (termine) {
    return (
      <div className="carte p-6 text-sm text-encre-600">
        Décision enregistrée. Le véhicule n’est plus modifiable par l’administration
        sur cette page.
      </div>
    );
  }

  return (
    <div className="carte space-y-4 p-6">
      <h2 className="font-semibold text-encre-900">Décision</h2>

      {erreur && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{erreur}</p>
      )}

      {!pret && (
        <p className="rounded-lg bg-marque-50 p-3 text-sm text-marque-800">
          La publication est bloquée tant que les points ci-dessus ne sont pas
          levés.
        </p>
      )}

      <div>
        <label htmlFor="motif" className="etiquette">
          Motif du refus (requis si refus)
        </label>
        <textarea
          id="motif"
          className="champ min-h-20 resize-y"
          maxLength={500}
          placeholder="Ce que le propriétaire doit corriger"
          value={motif}
          onChange={(e) => setMotif(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => decider('approve')}
          disabled={!pret || enCours !== null}
          className="bouton-primaire"
        >
          {enCours === 'approve' ? 'Publication…' : 'Publier'}
        </button>

        <button
          type="button"
          onClick={() => decider('reject')}
          disabled={enCours !== null}
          className="bouton-secondaire border-red-300 text-red-700 hover:bg-red-50"
        >
          {enCours === 'reject' ? 'Refus…' : 'Refuser'}
        </button>
      </div>
    </div>
  );
}
