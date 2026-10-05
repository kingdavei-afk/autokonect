'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

/**
 * Formulaire de reservation.
 *
 * ------------------------------------------------------------------------
 * LE DEVIS EST CALCULE COTE CLIENT, MAIS LA BASE FAIT FOI
 * ------------------------------------------------------------------------
 * Le nombre de jours et le total affiches ici reprennent la meme regle
 * que le serveur (`computeBilledDays`) : journee entiere, minimum 1.
 *
 * Ce n'est qu'un APERCU. Le devis qui fait foi est celui qu'enregistre
 * la reservation, et il est fige. Si les deux divergeaient, la facture
 * ne correspondrait pas a ce que l'utilisateur a vu — d'ou le controle
 * explicite du total renvoye par le serveur avant de confirmer.
 * ------------------------------------------------------------------------
 */
function joursFactures(debut: Date, fin: Date): number {
  const ms = fin.getTime() - debut.getTime();
  if (ms <= 0) return 0;
  return Math.max(1, Math.floor(ms / 86_400_000));
}

function versDateISO(date: Date): string {
  // `toISOString()` renvoie de l'UTC. Pour un envoi a l'API, c'est
  // correct et sans ambiguite ; pour un `<input type="date">`, il faut
  // la date locale, sinon le jour decale d'un jour a l'ouest de
  // Greenwich — symptomatique ici, ou le fuseau est UTC.
  return date.toISOString().slice(0, 10);
}

function debutDate(iso: string, heure = 8): Date {
  const d = new Date(`${iso}T00:00:00`);
  d.setHours(heure, 0, 0, 0);
  return d;
}

export function FormulaireReservation({
  vehiculeId,
  tarifJournalier,
  caution,
  devise,
}: {
  vehiculeId: string;
  tarifJournalier: string;
  caution: string;
  devise: string;
}) {
  const router = useRouter();

  const [debut, setDebut] = useState('');
  const [fin, setFin] = useState('');
  const [note, setNote] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  const apercu = useMemo(() => {
    if (!debut || !fin) return null;

    const d = debutDate(debut);
    const f = debutDate(fin);

    if (f <= d) return { invalide: true as const };

    const jours = joursFactures(d, f);
    const tarif = BigInt(tarifJournalier);
    const cautionBig = BigInt(caution);

    return {
      invalide: false as const,
      jours,
      location: tarif * BigInt(jours),
      total: tarif * BigInt(jours) + cautionBig,
    };
  }, [debut, fin, tarifJournalier, caution]);

  const formater = (valeur: bigint) =>
    new Intl.NumberFormat('fr-CI').format(Number(valeur));

  async function reserver(event: React.FormEvent) {
    event.preventDefault();
    setErreur(null);
    setEnCours(true);

    try {
      const reponse = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vehicleId: vehiculeId,
          startAt: debutDate(debut).toISOString(),
          endAt: debutDate(fin).toISOString(),
          isOneWay: false,
          customerNotes: note.trim() || undefined,
        }),
      });

      const donnees = (await reponse.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
        id?: string;
      };

      if (!reponse.ok) {
        setErreur(donnees.message ?? 'Réservation impossible.');
        return;
      }

      router.push(`/reservations/${donnees.id}`);
      router.refresh();
    } catch {
      setErreur('Le service est injoignable. Réessayez dans un instant.');
    } finally {
      setEnCours(false);
    }
  }

  return (
    <form onSubmit={reserver} className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="debut" className="etiquette">
            Départ
          </label>
          <input
            id="debut"
            type="date"
            className="champ"
            value={debut}
            min={versDateISO(new Date())}
            onChange={(e) => setDebut(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="fin" className="etiquette">
            Retour
          </label>
          <input
            id="fin"
            type="date"
            className="champ"
            value={fin}
            min={debut || versDateISO(new Date())}
            onChange={(e) => setFin(e.target.value)}
            required
          />
        </div>
      </div>

      <div>
        <label htmlFor="note" className="etiquette">
          Message au propriétaire <span className="font-normal text-encre-400">(facultatif)</span>
        </label>
        <textarea
          id="note"
          className="champ min-h-20 resize-y"
          maxLength={1000}
          placeholder="Heure de rendez-vous souhaitée, besoin particulier…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {apercu && !apercu.invalide && (
        <div className="rounded-lg bg-encre-50 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-encre-600">
              {apercu.jours} jour(s) × {formater(BigInt(tarifJournalier))} {devise}
            </span>
            <span className="font-medium text-encre-900">{formater(apercu.location)}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-encre-600">Caution (restituée)</span>
            <span className="text-encre-900">{formater(BigInt(caution))}</span>
          </div>
          <div className="mt-2 flex justify-between border-t border-encre-200 pt-2 text-base font-semibold">
            <span>Total</span>
            <span>{formater(apercu.total)} {devise}</span>
          </div>
        </div>
      )}

      {apercu?.invalide && (
        <p className="rounded-lg bg-marque-50 p-3 text-sm text-marque-800">
          La date de retour doit être postérieure à la date de départ.
        </p>
      )}

      {erreur && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{erreur}</p>
      )}

      <button
        type="submit"
        className="bouton-primaire w-full"
        disabled={enCours || !apercu || apercu.invalide}
      >
        {enCours ? 'Réservation…' : 'Réserver'}
      </button>

      <p className="text-xs leading-relaxed text-encre-500">
        La réservation n’est confirmée qu’après paiement. Le montant est
        calculé et figé par le serveur : l’aperçu ci-dessus peut différer à la
        dernière décimale près.
      </p>
    </form>
  );
}
