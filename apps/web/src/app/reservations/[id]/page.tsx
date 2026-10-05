import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, api, currentUser } from '@/lib/api';
import { couleurStatut, formatDateHeure, libelleStatut } from '@/lib/format';
import { formatMontant } from '@/lib/montants';
import { ActionsReservation } from './actions';

interface Detail {
  id: string;
  reference: string;
  status: string;
  startAt: string;
  endAt: string;
  total: string;
  deposit: string;
  currencyCode: string;
  version: number;
  customerNotes: string | null;
  cancelReason: string | null;
  allowedTransitions: string[];
  pricingSnapshot: {
    billedDays?: number;
    dailyRateAtCreation?: string;
    commissionRate?: number;
    commissionSource?: string;
    lines?: Array<{ label: string; amount: string }>;
  };
  vehicle: { id: string; brand: string; model: string; plateNumber: string };
  counterpart: { providerType: string; name: string };
  history: Array<{
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    at: string;
  }>;
}

export default async function PageReservation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();

  if (!user) {
    return (
      <div className="carte mx-auto max-w-md p-8 text-center">
        <p className="text-sm text-encre-600">Connectez-vous pour voir cette réservation.</p>
        <Link href="/connexion" className="bouton-primaire mt-6">
          Se connecter
        </Link>
      </div>
    );
  }

  let reservation: Detail | null = null;

  try {
    reservation = await api<Detail>(`/bookings/${id}`);
  } catch (e) {
    // 404 : la reservation n'existe pas, OU elle n'appartient pas a
    // l'appelant. L'API renvoie volontairement le meme code dans les
    // deux cas, pour ne pas confirmer l'existence d'une reservation
    // d'autrui. L'interface doit donc aussi ne pas les distinguer.
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  if (!reservation) notFound();

  const total = formatMontant(reservation.total, reservation.currencyCode);
  const caution = formatMontant(reservation.deposit, reservation.currencyCode);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/reservations" className="text-sm font-medium text-marque-700 hover:underline">
        ← Mes réservations
      </Link>

      <div className="carte p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-sm font-semibold text-encre-500">
              {reservation.reference}
            </p>
            <h1 className="mt-1 text-xl font-bold text-encre-900">
              {reservation.vehicle.brand} {reservation.vehicle.model}
            </h1>
            <p className="text-sm text-encre-500">Immatriculation {reservation.vehicle.plateNumber}</p>
          </div>
          <span className={`etiquette-statut ${couleurStatut(reservation.status)}`}>
            {libelleStatut(reservation.status)}
          </span>
        </div>

        <dl className="mt-6 grid gap-4 border-t border-encre-100 pt-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-encre-500">Départ</dt>
            <dd className="mt-1 text-sm font-medium text-encre-900">
              {formatDateHeure(reservation.startAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-encre-500">Retour</dt>
            <dd className="mt-1 text-sm font-medium text-encre-900">
              {formatDateHeure(reservation.endAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-encre-500">Propriétaire</dt>
            <dd className="mt-1 text-sm font-medium text-encre-900">
              {reservation.counterpart.name}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-encre-500">Durée</dt>
            <dd className="mt-1 text-sm font-medium text-encre-900">
              {reservation.pricingSnapshot.billedDays ?? '—'} jour(s)
            </dd>
          </div>
        </dl>
      </div>

      <div className="carte p-6">
        <h2 className="font-semibold text-encre-900">Détail du montant</h2>

        <dl className="mt-4 space-y-2 text-sm">
          {reservation.pricingSnapshot.lines?.map((ligne) => (
            <div key={ligne.label} className="flex justify-between gap-4">
              <dt className="text-encre-600">{ligne.label}</dt>
              <dd className="text-encre-900">
                {formatMontant(ligne.amount, reservation.currencyCode).complet}
              </dd>
            </div>
          ))}

          <div className="flex justify-between gap-4 border-t border-encre-100 pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd>{total.complet}</dd>
          </div>

          <div className="flex justify-between gap-4 text-xs text-encre-500">
            <dt>Caution (restituée après restitution)</dt>
            <dd>{caution.complet}</dd>
          </div>
        </dl>

        <p className="mt-4 rounded-lg bg-encre-50 p-3 text-xs leading-relaxed text-encre-600">
          Ce devis est <strong>figé</strong> : il ne sera pas recalculé, même si le
          tarif du véhicule change. Le taux de commission de la plateforme
          ({((reservation.pricingSnapshot.commissionRate ?? 0) * 100).toFixed(0)} %)
          est celui retenu au moment de la réservation.
        </p>
      </div>

      {reservation.status === 'awaiting_payment' && (
        <div className="carte border-marque-200 bg-marque-50 p-6">
          <h2 className="font-semibold text-marque-900">Paiement en attente</h2>
          <p className="mt-2 text-sm text-marque-800">
            Votre réservation est enregistrée et le véhicule est bloqué. Elle
            reste en attente 30 minutes avant d’être remise en catalogue.
          </p>
          <p className="mt-3 text-sm text-marque-900">
            Le module de paiement est en cours de construction : cette étape
            n’est pas encore disponible.
          </p>
        </div>
      )}

      {reservation.customerNotes && (
        <div className="carte p-6">
          <h2 className="font-semibold text-encre-900">Votre message</h2>
          <p className="mt-2 whitespace-pre-line text-sm text-encre-600">
            {reservation.customerNotes}
          </p>
        </div>
      )}

      {reservation.cancelReason && (
        <div className="carte p-6">
          <h2 className="font-semibold text-encre-900">Motif d’annulation</h2>
          <p className="mt-2 text-sm text-encre-600">{reservation.cancelReason}</p>
        </div>
      )}

      <div className="carte p-6">
        <h2 className="font-semibold text-encre-900">Historique</h2>

        <ol className="mt-4 space-y-3">
          {reservation.history.map((entree, index) => (
            <li key={`${entree.at}-${index}`} className="flex gap-3 text-sm">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-marque-500" />
              <div>
                <p className="font-medium text-encre-900">
                  {entree.fromStatus ? `${libelleStatut(entree.fromStatus)} → ` : ''}
                  {libelleStatut(entree.toStatus)}
                </p>
                <p className="text-xs text-encre-500">{formatDateHeure(entree.at)}</p>
                {entree.reason && (
                  <p className="mt-0.5 text-xs text-encre-600">{entree.reason}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <ActionsReservation
        id={reservation.id}
        version={reservation.version}
        statut={reservation.status}
        transitions={reservation.allowedTransitions}
      />
    </div>
  );
}
