import Link from 'next/link';

import { ApiError, api, currentUser } from '@/lib/api';
import { formatCompact } from '@/lib/montants';
import { RechercheVehicules } from './recherche';

interface Vehicule {
  id: string;
  brand: string;
  model: string;
  year: number;
  seats: number;
  transmission: string;
  dailyRate: string;
  depositAmount: string;
  currencyCode: string;
  status: string;
  brand_slug?: string;
}

interface ReponseListe {
  items: Vehicule[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

const TRANSMISSIONS: Record<string, string> = {
  manual: 'Manuelle',
  automatic: 'Automatique',
};

/**
 * Catalogue.
 *
 * Le catalogue exige une session : c'est un choix produit assume
 * (CDCS 12.4), il simplifie la lutte contre le scraping. Un visiteur
 * sans compte est donc redirige vers la connexion plutot que de voir
 * une page vide sans explication.
 */
export default async function PageCatalogue({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [user, filtres] = await Promise.all([currentUser(), searchParams]);

  if (!user) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <div className="carte p-8">
          <h1 className="text-xl font-semibold text-encre-900">Catalogue</h1>
          <p className="mt-2 text-sm text-encre-600">
            Connectez-vous pour voir les véhicules disponibles et réserver.
          </p>
          <Link href="/connexion" className="bouton-primaire mt-6">
            Se connecter
          </Link>
        </div>
      </div>
    );
  }

  const recherche = filtres['q']?.trim() ?? '';
  const page = Math.max(1, Number(filtres['page'] ?? '1') || 1);

  let vehicules: ReponseListe = { items: [], pagination: {
    page: 1, perPage: 12, total: 0, totalPages: 0, hasNext: false, hasPrevious: false,
  } };
  let erreur: string | null = null;

  try {
    const params = new URLSearchParams({ page: String(page), perPage: '12' });
    if (recherche) params.set('q', recherche);

    vehicules = await api<ReponseListe>(`/vehicles?${params.toString()}`);
  } catch (e) {
    // Un catalogue vide ne doit pas ressembler a « aucun vehicule » :
    // ce serait une information fausse. On le dit explicitement.
    erreur =
      e instanceof ApiError
        ? e.message
        : 'Le catalogue est momentanément indisponible.';
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-encre-900">Véhicules disponibles</h1>
        <p className="mt-1 text-sm text-encre-600">
          {vehicules.pagination.total > 0
            ? `${vehicules.pagination.total} véhicule(s) vérifié(s) par notre équipe.`
            : 'Chaque véhicule est contrôlé avant d’être publié.'}
        </p>
      </div>

      <RechercheVehicules rechercheInitiale={recherche} />

      {erreur && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {erreur}
        </div>
      )}

      {!erreur && vehicules.items.length === 0 && (
        <div className="carte p-8 text-center">
          <p className="text-sm text-encre-600">
            {recherche
              ? `Aucun véhicule ne correspond à « ${recherche} ».`
              : 'Aucun véhicule publié pour le moment.'}
          </p>
        </div>
      )}

      {vehicules.items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vehicules.items.map((vehicule) => (
            <Link
              key={vehicule.id}
              href={`/vehicules/${vehicule.id}`}
              className="carte group overflow-hidden transition hover:shadow-md"
            >
              <div className="grid h-40 place-items-center bg-gradient-to-br from-encre-100 to-encre-200 text-4xl font-bold text-encre-400">
                {vehicule.brand.slice(0, 2).toUpperCase()}
              </div>

              <div className="space-y-3 p-4">
                <div>
                  <h2 className="font-semibold text-encre-900 group-hover:text-marque-700">
                    {vehicule.brand} {vehicule.model}
                  </h2>
                  <p className="text-xs text-encre-500">
                    {vehicule.year} · {vehicule.seats} places ·{' '}
                    {TRANSMISSIONS[vehicule.transmission] ?? vehicule.transmission}
                  </p>
                </div>

                <div className="flex items-end justify-between border-t border-encre-100 pt-3">
                  <div>
                    <p className="text-sm font-semibold text-encre-900">
                      {formatCompact(vehicule.dailyRate, vehicule.currencyCode)}
                      <span className="text-xs font-normal text-encre-500"> / jour</span>
                    </p>
                    <p className="text-xs text-encre-500">
                      Caution {formatCompact(vehicule.depositAmount, vehicule.currencyCode)}
                    </p>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {vehicules.pagination.totalPages > 1 && (
        <nav className="flex justify-center gap-2">
          {Array.from({ length: vehicules.pagination.totalPages }, (_, i) => i + 1).map((n) => (
            <Link
              key={n}
              href={`/?page=${n}${recherche ? `&q=${encodeURIComponent(recherche)}` : ''}`}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${
                n === page ? 'bg-marque-600 text-white' : 'bg-white text-encre-600 hover:bg-encre-50'
              }`}
            >
              {n}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
