import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ApiError, api, currentUser } from '@/lib/api';
import { formatDateHeure } from '@/lib/format';
import { formatMontant } from '@/lib/montants';
import { DecisionAdmin } from './decision';

interface Examen {
  id: string;
  brand: string;
  model: string;
  year: number;
  plateNumber: string;
  status: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  dailyRate: string;
  depositAmount: string;
  currencyCode: string;
  publicationReadiness?: { ready: boolean; reasons: string[] };
  documents?: Array<{
    id: string;
    kind: string;
    status: string;
    expiresAt: string | null;
    rejectionReason?: string | null;
  }>;
}

const LIBELLES_DOC: Record<string, string> = {
  registration: 'Carte grise',
  insurance: 'Attestation d’assurance',
  rca: 'Responsabilité civile',
  technical_control: 'Contrôle technique',
  agency_licence: 'Agrément de loueur',
};

export default async function PageExamen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();

  if (!user?.roles.includes('admin')) {
    redirect('/');
  }

  let examen: Examen | null = null;

  try {
    examen = await api<Examen>(`/admin/vehicles/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  if (!examen) notFound();

  const raison = examen.publicationReadiness?.reasons ?? [];
  const pret = examen.publicationReadiness?.ready ?? false;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/admin/vehicules"
        className="text-sm font-medium text-marque-700 hover:underline"
      >
        ← File de validation
      </Link>

      <div className="carte p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-encre-900">
              {examen.brand} {examen.model}
            </h1>
            <p className="text-sm text-encre-500">
              {examen.year} · {examen.plateNumber}
            </p>
            {examen.submittedAt && (
              <p className="text-xs text-encre-500">
                Soumis le {formatDateHeure(examen.submittedAt)}
              </p>
            )}
          </div>
        </div>

        <dl className="mt-5 grid gap-4 border-t border-encre-100 pt-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-encre-500">Tarif journalier</dt>
            <dd className="mt-1 text-sm font-medium text-encre-900">
              {formatMontant(examen.dailyRate, examen.currencyCode).complet}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-encre-500">Caution</dt>
            <dd className="mt-1 text-sm font-medium text-encre-900">
              {formatMontant(examen.depositAmount, examen.currencyCode).complet}
            </dd>
          </div>
        </dl>
      </div>

      <div className="carte p-6">
        <h2 className="font-semibold text-encre-900">Documents de conformité</h2>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-encre-200 text-left text-xs uppercase tracking-wide text-encre-500">
              <th className="pb-2">Document</th>
              <th className="pb-2">État</th>
              <th className="pb-2">Expiration</th>
            </tr>
          </thead>
          <tbody>
            {(examen.documents ?? []).map((document) => {
              // La DATE prime sur le statut : un document « valide » mais
              // expire doit apparaitre comme tel. C'est la regle meme du
              // back-office, appliquée a l'affichage aussi.
              const expire = document.expiresAt
                ? new Date(document.expiresAt) < new Date()
                : false;

              return (
                <tr key={document.id} className="border-b border-encre-100 last:border-0">
                  <td className="py-2 text-encre-800">
                    {LIBELLES_DOC[document.kind] ?? document.kind}
                  </td>
                  <td className="py-2">
                    <span
                      className={`etiquette-statut ${
                        expire
                          ? 'bg-red-100 text-red-800'
                          : document.status === 'valid'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-marque-100 text-marque-800'
                      }`}
                    >
                      {expire ? 'Expiré' : document.status === 'valid' ? 'Valide' : 'À examiner'}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-encre-500">
                    {document.expiresAt ? formatDateHeure(document.expiresAt) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {raison.length > 0 && (
        <div className="carte border-marque-200 bg-marque-50 p-6">
          <h2 className="font-semibold text-marque-900">Publication bloquée</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-marque-800">
            {raison.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <DecisionAdmin
        id={examen.id}
        statut={examen.status}
        pret={pret}
      />
    </div>
  );
}
