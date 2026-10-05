'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * Barre de recherche.
 *
 * Utilise `useSearchParams`, donc le composant doit etre monte dans un
 * `Suspense` — Next l'exige pour ne pas rendre toute la page
 * dynamiquement a la reception du paquet.
 */
export function RechercheVehicules({ rechercheInitiale }: { rechercheInitiale: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [texte, setTexte] = useState(rechercheInitiale || params.get('q') || '');

  function rechercher(event: React.FormEvent) {
    event.preventDefault();

    const requete = texte.trim();
    // La page est remise a 1 : rester a la page 4 apres avoir change la
    // recherche affiche « aucun resultat » alors qu'il en existe.
    router.push(requete ? `/?q=${encodeURIComponent(requete)}&page=1` : '/');
  }

  return (
    <form onSubmit={rechercher} className="flex gap-2">
      <input
        className="champ"
        type="search"
        placeholder="Marque, modèle, catégorie…"
        value={texte}
        onChange={(e) => setTexte(e.target.value)}
        aria-label="Rechercher un véhicule"
      />
      <button type="submit" className="bouton-primaire shrink-0">
        Rechercher
      </button>
    </form>
  );
}
