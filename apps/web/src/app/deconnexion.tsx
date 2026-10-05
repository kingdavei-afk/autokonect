'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Deconnexion.
 *
 * Passe par un gestionnaire de route plutot que par un appel direct a
 * l'API : la deconnexion doit invalider la session SERVER-SIDE, y
 * compris le cookie `httpOnly`, qu'un script de page ne peut pas
 * effacer lui-meme.
 */
export function Deconnexion() {
  const router = useRouter();
  const [enCours, setEnCours] = useState(false);

  async function seDeconnecter() {
    setEnCours(true);
    try {
      await fetch('/api/session', { method: 'DELETE' });
      router.push('/');
      router.refresh();
    } finally {
      setEnCours(false);
    }
  }

  return (
    <button
      type="button"
      onClick={seDeconnecter}
      disabled={enCours}
      className="rounded-lg px-3 py-2 font-medium text-encre-600 hover:bg-encre-100 disabled:opacity-50"
    >
      {enCours ? 'Déconnexion…' : 'Déconnexion'}
    </button>
  );
}
