import Link from 'next/link';

import { ApiError, api, currentUser } from '@/lib/api';
import { couleurStatut, formatDateHeure, libelleStatut } from '@/lib/format';
import { formatMontant } from '@/lib/montants';

interface Reservation {
  id: string;
  reference: string;
  status: string;
  startAt: string;
  endAt: string;
  total: string;
  currencyCode: string;
  vehicle: { id: string; brand: string; model: string; plateNumber: string };
  counterpart: { providerType: string; name: string };
}

interface Reponse {
  items: Reservation[];
  pagination: { total: number; hasNext: boolean };
}

export default async function PageReservations() {
  const user = await currentUser();

  if (!user) {
    return (
      <div className="carte mx-auto max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold text-encre-900">Mes réservations</h1>
        <p className="mt-2 text-sm text-encre-600">
          Connectez-vous pour consulter vos réservations.
        </p>
        <Link href="/connexion" className="bouton-primaire mt-6">
          Se connecter
        </Link>
      </div>
    );
  }

  let reservations: Reponse = { items: [], pagination: { total: 0, hasNext: false } };
  let erreur: string | null = null;

  try {
    reservations = await api<Reponse>('/bookings?perPage=50');
  } catch (e) {
    erreur = e instanceof ApiError ? e.message : 'Liste indisponible.';
  }

  // La plus recente d'abord : c'est celle que l'utilisateur cherchera.
  const triees = [...reservations.items].sort(
    (a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime(),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-encre-900">Mes réservations</h1>
        <p className="mt-1 text-sm text-encre-600">
          {reservations.pagination.total} réservation(s) sur votre compte.
        </p>
      </div>

      {erreur && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {erreur}
        </div>
      )}

      {!erreur && triees.length === 0 && (
        <div className="carte p-10 text-center">
          <p className="text-sm text-encre-600">Aucune réservation pour le moment.</p>
          <Link href="/" className="bouton-primaire mt-4">
            Voir les véhicules
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {triees.map((reservation) => {
          const total = formatMontant(reservation.total, reservation.currencyCode);

          return (
            <Link
              key={reservation.id}
              href={`/reservations/${reservation.id}`}
              className="carte flex flex-wrap items-center gap-4 p-4 transition hover:shadow-md"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-encre-900">
                    {reservation.reference}
                  </span>
                  <span
                    className={`etiquette-statut ${couleurStatut(reservation.status)}`}
                  >
                    {libelleStatut(reservation.status)}
                  </span>
                </div>

                <p className="mt-1 text-sm font-medium text-encre-800">
                  {reservation.vehicle.brand} {reservation.vehicle.model}
                </p>
                <p className="text-xs text-encre-500">
                  {formatDateHeure(reservation.startAt)} → {formatDateHeure(reservation.endAt)}
                </p>
              </div>

              <div className="text-right">
                <p className="font-semibold text-encre-900">{total.complet}</p>
                <p className="text-xs text-encre-500">
                  {reservation.counterpart.name}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
