import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ApiError, api, currentUser } from '@/lib/api';
import { formatDateHeure } from '@/lib/format';

interface FileDeRevue {
  id: string;
  reference?: string;
  brand: string;
  model: string;
  year: number;
  plateNumber: string;
  status: string;
  submittedAt?: string | null;
  dailyRate: string;
  depositAmount: string;
  currencyCode: string;
  missingDocuments?: string[];
  publicationReadiness?: { ready: boolean; reasons: string[] };
}

const STATUTS: Record<string, string> = {
  draft: 'Brouillon',
  submitted: 'Soumis à validation',
  under_review: 'En cours d’examen',
  approved: 'Approuvé',
  rejected: 'Refusé',
  published: 'Publié',
};

const COULEURS: Record<string, string> = {
  draft: 'bg-encre-100 text-encre-600',
  submitted: 'bg-marque-100 text-marque-800',
  under_review: 'bg-sky-100 text-sky-800',
  approved: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-800',
  published: 'bg-emerald-100 text-emerald-800',
};

/**
 * File de validation (back-office).
 *
 * L'acces est verifie COTE SERVEUR et la page redirige si l'appelant
 * n'est pas administrateur. Une garde purement visuelle laisserait
 * decouvrir que la page existe a un visiteur non autorise.
 */
export default async function PageValidation({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await currentUser();

  if (!user?.roles.includes('admin')) {
    redirect('/');
  }

  const filtres = await searchParams;
  const statut = filtres['statut'] ?? 'submitted';

  let file: FileDeRevue[] = [];
  let erreur: string | null = null;

  try {
    const params = new URLSearchParams();
    if (statut !== 'all') params.set('status', statut);
    params.set('perPage', '50');

    const reponse = await api<{ items: FileDeRevue[] }>(
      `/admin/vehicles?${params.toString()}`,
    );
    file = reponse.items;
  } catch (e) {
    erreur = e instanceof ApiError ? e.message : 'File indisponible.';
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-encre-900">Validation des véhicules</h1>
        <p className="mt-1 text-sm text-encre-600">
          Aucun véhicule n’est visible des clients avant validation complète.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2">
        {['submitted', 'under_review', 'approved', 'rejected', 'published', 'all'].map((valeur) => (
          <Link
            key={valeur}
            href={valeur === 'all' ? '/admin/vehicules' : `/admin/vehicules?statut=${valeur}`}
            className={`rounded-lg px-3 py-2 text-sm font-medium ${
              statut === valeur
                ? 'bg-marque-600 text-white'
                : 'bg-white text-encre-600 hover:bg-encre-50'
            }`}
          >
            {valeur === 'all' ? 'Tous' : STATUTS[valeur] ?? valeur}
          </Link>
        ))}
      </nav>

      {erreur && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {erreur}
        </div>
      )}

      {!erreur && file.length === 0 && (
        <div className="carte p-10 text-center">
          <p className="text-sm text-encre-600">
            Aucun véhicule dans cet état.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {file.map((vehicule) => {
          const manquants = vehicule.publicationReadiness?.reasons ?? [];

          return (
            <Link
              key={vehicule.id}
              href={`/admin/vehicules/${vehicule.id}`}
              className="carte flex flex-wrap items-center gap-4 p-4 transition hover:shadow-md"
            >
              <div className="grid h-12 w-20 shrink-0 place-items-center rounded-lg bg-encre-100 text-sm font-bold text-encre-400">
                {vehicule.brand.slice(0, 2).toUpperCase()}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-encre-900">
                    {vehicule.brand} {vehicule.model}
                  </span>
                  <span
                    className={`etiquette-statut ${COULEURS[vehicule.status] ?? 'bg-encre-100 text-encre-700'}`}
                  >
                    {STATUTS[vehicule.status] ?? vehicule.status}
                  </span>
                </div>
                <p className="text-xs text-encre-500">
                  {vehicule.year} · {vehicule.plateNumber}
                  {vehicule.submittedAt && ` · soumis le ${formatDateHeure(vehicule.submittedAt)}`}
                </p>
              </div>

              {manquants.length > 0 && (
                <p className="text-xs text-marque-700">
                  {manquants.length} point(s) bloquant(s)
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
