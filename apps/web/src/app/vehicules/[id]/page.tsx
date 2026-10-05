import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, api, currentUser } from '@/lib/api';
import { formatCompact, formatMontant } from '@/lib/montants';
import { libelleRole } from '@/lib/format';
import { FormulaireReservation } from './reserver';

interface Vehicule {
  id: string;
  brand: string;
  model: string;
  year: number;
  seats: number;
  transmission: string;
  fuel: string;
  dailyRate: string;
  depositAmount: string;
  currencyCode: string;
  status: string;
  description?: string | null;
  publicationReadiness?: { ready: boolean; reasons: string[] };
}

const CARBURANTS: Record<string, string> = {
  petrol: 'Essence',
  diesel: 'Diesel',
  hybrid: 'Hybride',
  electric: 'Électrique',
  lpg: 'GPL',
};

const TRANSMISSIONS: Record<string, string> = {
  manual: 'Manuelle',
  automatic: 'Automatique',
};

export default async function PageVehicule({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();

  let vehicule: Vehicule | null = null;
  let erreur: string | null = null;

  try {
    vehicule = await api<Vehicule>(`/vehicles/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    erreur = e instanceof ApiError ? e.message : 'Véhicule indisponible.';
  }

  if (erreur || !vehicule) {
    return (
      <div className="carte p-8 text-center">
        <p className="text-sm text-encre-600">{erreur}</p>
        <Link href="/" className="bouton-secondaire mt-4">
          Retour au catalogue
        </Link>
      </div>
    );
  }

  const tarif = formatMontant(vehicule.dailyRate, vehicule.currencyCode);
  const caution = formatMontant(vehicule.depositAmount, vehicule.currencyCode);

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm font-medium text-marque-700 hover:underline">
        ← Retour au catalogue
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div className="grid h-64 place-items-center rounded-xl bg-gradient-to-br from-encre-100 to-encre-200 text-6xl font-bold text-encre-400">
            {vehicule.brand.slice(0, 2).toUpperCase()}
          </div>

          <div>
            <h1 className="text-2xl font-bold text-encre-900">
              {vehicule.brand} {vehicule.model}
            </h1>
            <p className="mt-1 text-sm text-encre-600">
              {vehicule.year} · {libelleRole('owner')}
            </p>
          </div>

          <div className="carte grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
            {[
              ['Places', String(vehicule.seats)],
              ['Boîte', TRANSMISSIONS[vehicule.transmission] ?? vehicule.transmission],
              ['Carburant', CARBURANTS[vehicule.fuel] ?? vehicule.fuel],
              ['Statut', vehicule.status === 'published' ? 'Vérifié' : 'En validation'],
            ].map(([libelle, valeur]) => (
              <div key={libelle}>
                <p className="text-xs uppercase tracking-wide text-encre-500">{libelle}</p>
                <p className="mt-1 text-sm font-medium text-encre-900">{valeur}</p>
              </div>
            ))}
          </div>

          {vehicule.description && (
            <div className="carte p-5">
              <h2 className="font-semibold text-encre-900">Description</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-encre-600">
                {vehicule.description}
              </p>
            </div>
          )}

          <div className="carte p-5">
            <h2 className="font-semibold text-encre-900">Conditions de location</h2>
            <ul className="mt-3 space-y-2 text-sm text-encre-600">
              <li className="flex justify-between gap-4">
                <span>Tarif journalier</span>
                <span className="font-medium text-encre-900">{tarif.complet}</span>
              </li>
              <li className="flex justify-between gap-4">
                <span>Caution (restituée)</span>
                <span className="font-medium text-encre-900">{caution.complet}</span>
              </li>
              <li className="flex justify-between gap-4 border-t border-encre-100 pt-2">
                <span>Durée minimum</span>
                <span className="font-medium text-encre-900">1 jour</span>
              </li>
            </ul>
          </div>
        </div>

        <aside>
          {user ? (
            <div className="carte sticky top-6 p-5">
              <p className="text-sm text-encre-500">
                À partir de{' '}
                <span className="text-xl font-bold text-encre-900">
                  {formatCompact(vehicule.dailyRate, vehicule.currencyCode)}
                </span>{' '}
                / jour
              </p>

              {vehicule.status !== 'published' ? (
                <p className="mt-4 rounded-lg bg-marque-50 p-3 text-sm text-marque-800">
                  Ce véhicule est en cours de vérification. Il n’est pas encore
                  réservable.
                </p>
              ) : (
                <FormulaireReservation
                  vehiculeId={vehicule.id}
                  tarifJournalier={vehicule.dailyRate}
                  caution={vehicule.depositAmount}
                  devise={vehicule.currencyCode}
                />
              )}
            </div>
          ) : (
            <div className="carte sticky top-6 p-5">
              <p className="text-sm text-encre-600">
                Connectez-vous pour vérifier les disponibilités et réserver.
              </p>
              <Link href="/connexion" className="bouton-primaire mt-4 w-full">
                Se connecter
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
