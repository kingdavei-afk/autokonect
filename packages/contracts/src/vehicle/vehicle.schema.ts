import { z } from 'zod';

/**
 * Contrats du catalogue vehicule.
 *
 * Partages entre l'API et les clients : une modification du contrat
 * echoue a la compilation des deux cotes, au lieu de produire une
 * erreur de forme reperee par un utilisateur.
 */

// ---------------------------------------------------------------------------
// Regles de format communes
// ---------------------------------------------------------------------------

export const uuidSchema = z.string().uuid();

/**
 * Montant transmis par le client.
 *
 * Accepte une chaine ou un nombre mais impose un ENTIER : un montant
 * decimal recu par l'API ne doit jamais etre arrondi silencieusement
 * (CDCS 4.3).
 */
export const moneyInputSchema = z.union([
  z
    .string()
    .regex(/^\d+$/, 'Montant attendu : entier positif, sans decimale.'),
  z
    .number()
    .int('Montant attendu : entier positif, sans decimale.')
    .nonnegative('Montant attendu : positif.'),
]);

/** Plaque d'immatriculation : 2 a 12 caracteres, sans ponctuation. */
/**
 * Montant en SORTIE : chaine d'entiers uniquement.
 *
 * Distinct de `moneyInputSchema`, qui accepte un nombre pour la
 * commodite du client. En sortie, la forme est imposee : le serveur
 * ne doit jamais pouvoir emettre un montant decimal, meme si un bogue
 * interne l'introduisait. Le retour est une chaine parce que le
 * pilote `pg` renvoie les `bigint` sous forme de chaine : cela evite
 * toute perte de precision du JSON vers JavaScript.
 */
export const moneyOutputSchema = z
  .string()
  .regex(/^\d+$/, 'Montant attendu : entier positif en chaine.');

/** Note moyenne : chaine decimale ou null si aucun avis. */
export const ratingOutputSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Note invalide.');

export const plateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,12}$/, {
    message:
      'Plaque invalide. Format attendu : 2 a 12 caracteres alphanumeriques, ex. AB-123-CD.',
  });

export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Code pays invalide : 2 lettres, ex. CI.');

export const transmissionSchema = z.enum(['manual', 'automatic']);
export const fuelSchema = z.enum(['petrol', 'diesel', 'hybrid', 'electric', 'lpg']);

// ---------------------------------------------------------------------------
// Creation et modification
// ---------------------------------------------------------------------------

/** Champs communs a la creation et a la modification. */
const vehicleCoreShape = {
  categoryId: uuidSchema,
  brand: z.string().trim().min(1, 'Marque requise.').max(80),
  model: z.string().trim().min(1, 'Modele requis.').max(80),
  year: z
    .number()
    .int()
    .min(1950, 'Annee trop ancienne.')
    .max(new Date().getFullYear() + 2, 'Annee trop recente.'),
  plateCountry: countryCodeSchema.default('CI'),
  plateNumber: plateSchema,
  color: z.string().trim().max(40).optional(),
  transmission: transmissionSchema,
  fuel: fuelSchema,
  seats: z.number().int().min(1, 'Au moins un siege.').max(30),
  airConditioning: z.boolean().default(true),
  doors: z.number().int().min(2).max(8).optional(),
  luggageCapacity: z.number().int().min(0).max(50).optional(),
  /** Consommation en L/100km ou kWh/100km selon le carburant. */
  consumption: z.number().min(0).max(100).optional(),
  dailyRate: moneyInputSchema,
  depositAmount: moneyInputSchema.default('0'),
  currencyCode: z.string().trim().length(3).default('XOF'),
  withDriver: z.boolean().default(false),
  driverIncludedInRate: z.boolean().default(false),
  minDays: z.number().int().min(1).max(90).default(1),
  maxKmPerDay: z.number().int().min(0).max(5_000).optional(),
  locationId: uuidSchema.optional(),
  features: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
};

export const createVehicleSchema = z
  .object(vehicleCoreShape)
  .strict()
  .superRefine((value, ctx) => {
    // Un chauffeur inclus dans le tarif sansVehicule de type
    // « avec chauffeur » produirait un prix incoherent.
    if (value.driverIncludedInRate && !value.withDriver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['driverIncludedInRate'],
        message:
          'Le conducteur ne peut etre inclus dans le tarif que si le vehicule est propose avec chauffeur.',
      });
    }

    // Un vehicule electrique n announcing pas de clim motorisee
    //angue : signaler plutot que d'accepter une donnee incoherente.
    if (value.fuel === 'electric' && value.consumption !== undefined && value.consumption > 60) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consumption'],
        message:
          'Consommation implausible pour un vehicule electrique (attendu en kWh/100km).',
      });
    }
  });
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

export const updateVehicleSchema = z
  .object({
    categoryId: uuidSchema.optional(),
    brand: z.string().trim().min(1).max(80).optional(),
    model: z.string().trim().min(1).max(80).optional(),
    year: z.number().int().min(1950).max(new Date().getFullYear() + 2).optional(),
    color: z.string().trim().max(40).nullable().optional(),
    transmission: transmissionSchema.optional(),
    fuel: fuelSchema.optional(),
    seats: z.number().int().min(1).max(30).optional(),
    airConditioning: z.boolean().optional(),
    doors: z.number().int().min(2).max(8).nullable().optional(),
    luggageCapacity: z.number().int().min(0).max(50).nullable().optional(),
    consumption: z.number().min(0).max(100).nullable().optional(),
    dailyRate: moneyInputSchema.optional(),
    depositAmount: moneyInputSchema.optional(),
    withDriver: z.boolean().optional(),
    driverIncludedInRate: z.boolean().optional(),
    minDays: z.number().int().min(1).max(90).optional(),
    maxKmPerDay: z.number().int().min(0).max(5_000).nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    features: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  })
  .strict();
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------

/** Filtres de recherche catalogue (CDCS 9). */
/**
 * Pagination d'une REQUETE.
 *
 * ⚠️ A NE PAS CONFONDRE avec `paginationSchema`, qui decrit la REPONSE.
 *
 * Les deux exposent `page` et `perPage`, et rien ne les distingue a la
 * lecture. Utiliser la mauvaise fait exiger au client des champs qu'il
 * n'envoie jamais — `total`, `totalPages`, `hasNext`, `hasPrevious` — et
 * chaque liste se termine alors par un « 400 Donnees invalides » sur une
 * requete parfaitement legitime.
 *
 * C'est exactement ce qui est arrive sur `/bookings`. Les deux formes
 * sont donc nommees, et la forme de requete est extraite pour ne plus
 * etre recopiee dans chaque schema de recherche.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
});

export const vehicleSearchSchema = z
  .object({
    // Texte libre : marque, modele, categorie.
    q: z.string().trim().min(1).max(120).optional(),

    locationId: uuidSchema.optional(),
    countryCode: countryCodeSchema.optional(),

    categoryId: uuidSchema.optional(),
    transmission: transmissionSchema.optional(),
    fuel: fuelSchema.optional(),
    seats: z.coerce.number().int().min(1).max(30).optional(),
    yearFrom: z.coerce.number().int().min(1950).max(2100).optional(),
    yearTo: z.coerce.number().int().min(1950).max(2100).optional(),

    minPrice: moneyInputSchema.optional(),
    maxPrice: moneyInputSchema.optional(),

    withDriver: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    airConditioning: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    /** `true` = vehicule uniquement avec chauffeur. */
    onlyWithDriver: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),

    // Disponibilite : intervalle [startDate, endDate) exclusif.
    availableFrom: z.coerce.date().optional(),
    availableTo: z.coerce.date().optional(),

    minRating: z.coerce.number().min(0).max(5).optional(),

    // Tri
    sort: z
      .enum(['relevance', 'price_asc', 'price_desc', 'rating_desc', 'newest'])
      .default('relevance'),

    // Pagination
    ...paginationQuerySchema.shape,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.availableFrom &&
      value.availableTo &&
      value.availableFrom >= value.availableTo
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availableTo'],
        message: 'La date de fin doit etre posterieure a la date de debut.',
      });
    }

    if (value.yearFrom !== undefined && value.yearTo !== undefined && value.yearFrom > value.yearTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['yearTo'],
        message: "L'annee maximale doit etre superieure ou egale a l'annee minimale.",
      });
    }

    if (value.minPrice !== undefined && value.maxPrice !== undefined) {
      const min = BigInt(value.minPrice as string);
      const max = BigInt(value.maxPrice as string);
      if (min > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['maxPrice'],
          message: 'Le prix maximum doit etre superieur ou egal au prix minimum.',
        });
      }
    }
  });
export type VehicleSearchInput = z.infer<typeof vehicleSearchSchema>;

// ---------------------------------------------------------------------------
// Documents de conformite (CDCS 3.1)
// ---------------------------------------------------------------------------

export const vehicleDocumentKindSchema = z.enum([
  'registration',
  'insurance',
  'rca',
  'technical_control',
  'agency_licence',
]);

export const uploadDocumentSchema = z
  .object({
    kind: vehicleDocumentKindSchema,
    fileUrl: z.string().url('URL de fichier invalide.'),
    issuedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.issuedAt &&
      value.expiresAt &&
      value.issuedAt >= value.expiresAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: "La date d'expiration doit etre posterieure a la date de delivrance.",
      });
    }
  });
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

// ---------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------

export const vehicleMediaSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['photo', 'video']),
  url: z.string().url(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  sortOrder: z.number().int(),
  isCover: z.boolean(),
});

export const vehicleDocumentSchema = z.object({
  id: uuidSchema,
  kind: vehicleDocumentKindSchema,
  fileUrl: z.string().url(),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** Statut derive du document ; l'expiration est calculee cote serveur. */
  status: z.enum(['pending', 'valid', 'expired', 'rejected']),
  rejectReason: z.string().nullable(),
});

export const vehicleSummarySchema = z.object({
  id: uuidSchema,
  brand: z.string(),
  model: z.string(),
  year: z.number().int(),
  categoryId: uuidSchema,
  categoryLabel: z.string(),
  transmission: transmissionSchema,
  fuel: fuelSchema,
  seats: z.number().int(),
  dailyRate: moneyOutputSchema,
  /**
   * Caution, des le resume.
   *
   * Elle determine le choix du vehicule autant que le tarif : c'est
   * souvent elle qui fait basculer la decision, et un client qui
   * decouvre la caution apres avoir choisi juge l'info tardive.
   *
   * Elle figurait auparavant uniquement dans le detail. Le catalogue
   * affichait donc « Caution 0 XOF » — l'absence du champ etait
   * interpretee comme un montant nul, ce qui laisse croire a une
   * caution gratuite.
   */
  depositAmount: moneyOutputSchema,
  currencyCode: z.string().length(3),
  withDriver: z.boolean(),
  rating: ratingOutputSchema.nullable(),
  ratingsCount: z.number().int(),
  coverUrl: z.string().url().nullable(),
  locationId: z.string().uuid().nullable(),
});
export type VehicleSummary = z.infer<typeof vehicleSummarySchema>;

export const vehicleDetailSchema = vehicleSummarySchema.extend({
  plateCountry: z.string().length(2),
  plateNumber: z.string(),
  color: z.string().nullable(),
  airConditioning: z.boolean(),
  doors: z.number().int().nullable(),
  luggageCapacity: z.number().int().nullable(),
  consumption: z.number().nullable(),
  depositAmount: moneyOutputSchema,
  driverIncludedInRate: z.boolean(),
  minDays: z.number().int(),
  maxKmPerDay: z.number().int().nullable(),
  status: z.enum(['draft', 'in_review', 'published', 'rejected', 'archived']),
  features: z.array(z.string()),
  media: z.array(vehicleMediaSchema),
  documents: z.array(vehicleDocumentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VehicleDetail = z.infer<typeof vehicleDetailSchema>;

/** Documents manquants ou expirees bloquant la publication (CDCS 7.2). */
export const publicationReadinessSchema = z.object({
  ready: z.boolean(),
  missingDocuments: z.array(vehicleDocumentKindSchema),
  expiredDocuments: z.array(vehicleDocumentKindSchema),
  reasons: z.array(z.string()),
});
export type PublicationReadiness = z.infer<typeof publicationReadinessSchema>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Pagination d'une REPONSE. */
export const paginationSchema = z.object({
  page: z.number().int().min(1),
  perPage: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  hasNext: z.boolean(),
  hasPrevious: z.boolean(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/** Reponse paginee generique. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    pagination: paginationSchema,
  });
}

export function buildPagination(
  page: number,
  perPage: number,
  total: number,
): Pagination {
  const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 0;

  return {
    page,
    perPage,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && total > 0,
  };
}