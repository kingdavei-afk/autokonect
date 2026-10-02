import type { Selectable, VehicleTable } from '@adkcars/database';

/**
 * Ligne `vehicle` en lecture.
 *
 * Derivative de la declaration Kysely : si une colonne change dans la
 * migration, ce type change et l'erreur apparait a la compilation.
 */
export type VehicleRow = Selectable<VehicleTable>;

/**
 * Source de la conversion vers le contrat de sortie `VehicleSummary`.
 *
 * Volontairement limitee aux champs reellement utilises : la
 * conversion accepte ainsi aussi bien une ligne issue d'une requete de
 * liste (selection partielle) qu'une ligne complete.
 */
export interface VehicleSummarySource {
  id: string;
  brand: string;
  model: string;
  year: number;
  category_id: string;
  transmission: 'manual' | 'automatic';
  fuel: 'petrol' | 'diesel' | 'hybrid' | 'electric' | 'lpg';
  seats: number;
  daily_rate: string;
  currency_code: string;
  with_driver: boolean;
  rating: string | null;
  ratings_count: number;
  location_id: string | null;
  category_label?: string;
  cover_url?: string | null;
}