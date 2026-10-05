import { describe, expect, it } from 'vitest';

import {
  buildPagination,
  createVehicleSchema,
  moneyInputSchema,
  paginated,
  plateSchema,
  uploadDocumentSchema,
  vehicleSearchSchema,
  vehicleSummarySchema,
} from './vehicle.schema.js';

/** Vehicule de reference, valide. */
const validVehicle = {
  categoryId: '11111111-1111-4111-8111-111111111111',
  brand: 'Renault',
  model: 'Talisman',
  year: 2022,
  plateNumber: 'AB123CD',
  transmission: 'automatic' as const,
  fuel: 'petrol' as const,
  seats: 5,
  dailyRate: '3500000',
};

describe('montants recus du client', () => {
  it('accepte une chaine d entiers', () => {
    expect(moneyInputSchema.parse('3500000')).toBe('3500000');
  });

  it('accepte un entier', () => {
    expect(moneyInputSchema.parse(3_500_000)).toBe(3_500_000);
  });

  it('refuse un decimal', () => {
    // Un montant decimal recu par l'API ne doit jamais etre arrondi
    // silencieusement (CDCS 4.3).
    expect(() => moneyInputSchema.parse('3500.50')).toThrow();
    expect(() => moneyInputSchema.parse(3500.5)).toThrow();
  });

  it('refuse un montant negatif', () => {
    expect(() => moneyInputSchema.parse(-1)).toThrow();
    expect(() => moneyInputSchema.parse('-1')).toThrow();
  });

  it('refuse un montant non numerique', () => {
    expect(() => moneyInputSchema.parse('beaucoup')).toThrow();
  });
});

describe('plaque d immatriculation', () => {
  it('accepte une plaque alphanumerique', () => {
    expect(plateSchema.parse('AB123CD')).toBe('AB123CD');
  });

  it('met en majuscules', () => {
    expect(plateSchema.parse('ab123cd')).toBe('AB123CD');
  });

  it('retire les espaces', () => {
    expect(plateSchema.parse('  AB123CD  ')).toBe('AB123CD');
  });

  it('refuse la ponctuation', () => {
    expect(() => plateSchema.parse('AB-123-CD')).toThrow();
  });

  it('refuse une plaque trop courte ou trop longue', () => {
    expect(() => plateSchema.parse('A')).toThrow();
    expect(() => plateSchema.parse('A'.repeat(13))).toThrow();
  });
});

describe('creation de vehicule', () => {
  it('accepte un vehicule valide et complete les valeurs par defaut', () => {
    const result = createVehicleSchema.parse(validVehicle);

    expect(result.currencyCode).toBe('XOF');
    expect(result.plateCountry).toBe('CI');
    expect(result.minDays).toBe(1);
    expect(result.withDriver).toBe(false);
    expect(result.depositAmount).toBe('0');
  });

  it('refuse un champ non declare', () => {
    // Ignorer un champ en trop reviendrait a accepter une requete que
    // l on ne maitrise pas (CDCS 12.4).
    expect(() =>
      createVehicleSchema.parse({ ...validVehicle, admin: true }),
    ).toThrow();
  });

  it('refuse un tarif journalier absent', () => {
    const { dailyRate, ...sansTarif } = validVehicle;
    void dailyRate;
    expect(() => createVehicleSchema.parse(sansTarif)).toThrow();
  });

  it('refuse un tarif decimal', () => {
    expect(() =>
      createVehicleSchema.parse({ ...validVehicle, dailyRate: '35000.50' }),
    ).toThrow();
  });

  it('refuse un annee aberrante', () => {
    expect(() => createVehicleSchema.parse({ ...validVehicle, year: 1800 })).toThrow();
    expect(() =>
      createVehicleSchema.parse({ ...validVehicle, year: new Date().getFullYear() + 5 }),
    ).toThrow();
  });

  it('refuse un conducteur inclus dans un vehicule sans chauffeur', () => {
    expect(() =>
      createVehicleSchema.parse({
        ...validVehicle,
        withDriver: false,
        driverIncludedInRate: true,
      }),
    ).toThrow(/chauffeur/i);
  });

  it('accepte un conducteur inclus pour un vehicule avec chauffeur', () => {
    expect(
      createVehicleSchema.parse({
        ...validVehicle,
        withDriver: true,
        driverIncludedInRate: true,
      }).driverIncludedInRate,
    ).toBe(true);
  });

  it('refuse une consommation electrique implausible', () => {
    expect(() =>
      createVehicleSchema.parse({
        ...validVehicle,
        fuel: 'electric',
        consumption: 300,
      }),
    ).toThrow(/electrique/i);
  });

  it('refuse un nombre de sieges nul', () => {
    expect(() => createVehicleSchema.parse({ ...validVehicle, seats: 0 })).toThrow();
  });
});

describe('recherche', () => {
  it('applique des valeurs par defaut', () => {
    const result = vehicleSearchSchema.parse({});

    expect(result.page).toBe(1);
    expect(result.perPage).toBe(20);
    expect(result.sort).toBe('relevance');
  });

  it('convertit les chaines de requete en nombres', () => {
    const result = vehicleSearchSchema.parse({
      page: '2',
      perPage: '50',
      yearFrom: '2020',
      seats: '7',
    });

    expect(result.page).toBe(2);
    expect(result.perPage).toBe(50);
    expect(result.yearFrom).toBe(2020);
    expect(result.seats).toBe(7);
  });

  it('convertit les booleens de requete', () => {
    expect(vehicleSearchSchema.parse({ withDriver: 'true' }).withDriver).toBe(true);
    expect(vehicleSearchSchema.parse({ withDriver: 'false' }).withDriver).toBe(false);
  });

  it('limite la taille de page', () => {
    expect(() => vehicleSearchSchema.parse({ perPage: '500' })).toThrow();
    expect(() => vehicleSearchSchema.parse({ perPage: '0' })).toThrow();
  });

  it('refuse un intervalle de dates inverse', () => {
    expect(() =>
      vehicleSearchSchema.parse({
        availableFrom: '2026-12-20',
        availableTo: '2026-12-10',
      }),
    ).toThrow();
  });

  it('accepte un intervalle de dates valide', () => {
    const result = vehicleSearchSchema.parse({
      availableFrom: '2026-12-10',
      availableTo: '2026-12-20',
    });

    expect(result.availableFrom).toBeInstanceOf(Date);
  });

  it('refuse un intervalle de prix inverse', () => {
    expect(() =>
      vehicleSearchSchema.parse({ minPrice: '5000', maxPrice: '1000' }),
    ).toThrow();
  });

  it('refuse un intervalle d annees inverse', () => {
    expect(() => vehicleSearchSchema.parse({ yearFrom: 2023, yearTo: 2020 })).toThrow();
  });

  it('refuse un filtre inconnu', () => {
    expect(() => vehicleSearchSchema.parse({ couleur: 'rouge' })).toThrow();
  });
});

describe('documents de conformite', () => {
  it('accepte un document valide', () => {
    const result = uploadDocumentSchema.parse({
      kind: 'rca',
      fileUrl: 'https://files.adkcars.ci/rca-123.pdf',
      expiresAt: '2027-06-30',
    });

    expect(result.kind).toBe('rca');
  });

  it('refuse une expiration anterieure a la delivrance', () => {
    expect(() =>
      uploadDocumentSchema.parse({
        kind: 'insurance',
        fileUrl: 'https://files.adkcars.ci/assurance.pdf',
        issuedAt: '2026-01-01',
        expiresAt: '2025-12-31',
      }),
    ).toThrow();
  });

  it('refuse une URL invalide', () => {
    expect(() =>
      uploadDocumentSchema.parse({ kind: 'rca', fileUrl: 'pas-une-url' }),
    ).toThrow();
  });

  it('refuse un type de document inconnu', () => {
    expect(() =>
      uploadDocumentSchema.parse({
        kind: 'permis_de_lire',
        fileUrl: 'https://files.adkcars.ci/x.pdf',
      }),
    ).toThrow();
  });
});

describe('pagination', () => {
  it('calcule le nombre de pages', () => {
    const result = buildPagination(1, 20, 45);

    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrevious).toBe(false);
  });

  it('detecte la derniere page', () => {
    const result = buildPagination(3, 20, 45);

    expect(result.hasNext).toBe(false);
    expect(result.hasPrevious).toBe(true);
  });

  it('gere un resultat vide', () => {
    const result = buildPagination(1, 20, 0);

    expect(result.totalPages).toBe(0);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrevious).toBe(false);
  });

  it('gere une division exacte', () => {
    const result = buildPagination(2, 20, 40);

    expect(result.totalPages).toBe(2);
    expect(result.hasNext).toBe(false);
  });

  it('produit une reponse paginee typee', () => {
    const schema = paginated(vehicleSummarySchema);
    const result = schema.parse({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          brand: 'Renault',
          model: 'Talisman',
          year: 2022,
          categoryId: '11111111-1111-4111-8111-111111111111',
          categoryLabel: 'Berline',
          transmission: 'automatic',
          fuel: 'petrol',
          seats: 5,
          dailyRate: '3500000',
          // La caution fait partie du resume : c'est elle que l'interface
          // affiche sur une carte du catalogue. Son absence s'y lisait
          // « Caution 0 XOF », c'est-a-dire « aucune caution demandee ».
          depositAmount: '500000',
          currencyCode: 'XOF',
          withDriver: false,
          rating: null,
          ratingsCount: 0,
          coverUrl: null,
          locationId: null,
        },
      ],
      pagination: buildPagination(1, 20, 1),
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.categoryLabel).toBe('Berline');
    expect(result.pagination.total).toBe(1);
  });

  it('refuse un montant decimal dans une reponse', () => {
    // Le serveur ne doit jamais pouvoir produire un montant decimal,
    // meme si un bogue interne l emettait.
    const schema = paginated(vehicleSummarySchema);

    expect(() =>
      schema.parse({
        items: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            brand: 'Renault',
            model: 'Talisman',
            year: 2022,
            categoryId: '11111111-1111-4111-8111-111111111111',
            categoryLabel: 'Berline',
            transmission: 'automatic',
            fuel: 'petrol',
            seats: 5,
            dailyRate: '35000.50',
            currencyCode: 'XOF',
            withDriver: false,
            rating: null,
            ratingsCount: 0,
            coverUrl: null,
            locationId: null,
          },
        ],
        pagination: buildPagination(1, 20, 1),
      }),
    ).toThrow();
  });
});
