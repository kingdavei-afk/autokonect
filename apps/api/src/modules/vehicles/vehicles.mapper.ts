import type { VehicleSummary } from '@adkcars/contracts';

import type { VehicleSummarySource } from './vehicles.types';

/**
 * Conversion d'une ligne base vers le contrat de sortie.
 *
 * Isolee dans un fichier dedie pour que la conversion soit verifiable
 * et que le service ne contienne que de la logique metier.
 *
 * Aucun arrondi ni conversion de type n'est applique : les montants
 * sont transmis tels que stockes. Les convertir en `number` ici
 * introduirait une perte de precision silencieuse sur les grands
 * montants (CDCS 4.3).
 */
export function toSummary(row: VehicleSummarySource): VehicleSummary {
  return {
    id: row.id,
    brand: row.brand,
    model: row.model,
    year: row.year,
    categoryId: row.category_id,
    categoryLabel: row.category_label ?? '',
    transmission: row.transmission,
    fuel: row.fuel,
    seats: row.seats,
    dailyRate: row.daily_rate,
    depositAmount: row.deposit_amount,
    currencyCode: row.currency_code,
    withDriver: row.with_driver,
    rating: row.rating,
    ratingsCount: row.ratings_count,
    coverUrl: row.cover_url ?? null,
    locationId: row.location_id,
  };
}