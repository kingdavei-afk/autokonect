import { z } from 'zod';

/**
 * Schemas d'entree et de sortie de l'authentification.
 *
 * Meme source de verite pour la validation serveur et le typage du
 * client : le message d'erreur affiche dans l'application mobile est
 * donc exactement celui renvoye par l'API.
 */

// ---------------------------------------------------------------------------
// Regles de format
// ---------------------------------------------------------------------------

/**
 * Numero de telephone en E.164 : `+` suivi de 8 a 15 chiffres.
 * Exemples ivoiriens acceptes : +2250700000000, +2250102030405.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, {
    message:
      'Numero invalide. Format attendu : indicatif international puis le numero, ex. +2250700000000',
  });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'Adresse email invalide.' })
  .max(254);

/**
 * Robustesse du mot de passe.
 *
 * On impose une longueur (12 caracteres minimum) plutot qu'un melange
 * de classes de caracteres : une longueur generosement resiste
 * nettement mieux a l'attaque par dictionnaire, tout en etant
 * applicable a un marche ou les utilisateurs ne sont pas informaticiens
 * (CDCS 13.5, principe de lisibilite).
 */
export const passwordSchema = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caracteres.')
  .max(128, 'Le mot de passe est trop long.')
  .refine((value) => value.trim().length === value.length, {
    message: 'Le mot de passe ne doit pas commencer ni finir par un espace.',
  })
  .refine((value) => !/^(.)\1+$/.test(value), {
    message: 'Le mot de passe ne peut pas etre un caractere repete.',
  });

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { message: 'Le code comporte 6 chiffres.' });

/** Identifiant de connexion : email ou numero de telephone. */
export const identifierSchema = z
  .string()
  .trim()
  .min(3, 'Identifiant trop court.')
  .max(254);

// ---------------------------------------------------------------------------
// Inscription
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
  /** Role demande. Restreint : un client ne peut pas s'auto-attribuer admin. */
  role: z.enum(['client', 'owner', 'driver']).default('client'),
  acceptTerms: z.literal(true, {
    message: "Les conditions d'utilisation doivent etre acceptees.",
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

// ---------------------------------------------------------------------------
// Verification du telephone
// ---------------------------------------------------------------------------

export const verifyPhoneSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
});
export type VerifyPhoneInput = z.infer<typeof verifyPhoneSchema>;

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  identifier: identifierSchema,
  password: z.string().min(1, 'Mot de passe requis.').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Rafraichissement
// ---------------------------------------------------------------------------

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});

// ---------------------------------------------------------------------------
// Reinitialisation du mot de passe
// ---------------------------------------------------------------------------

export const requestPasswordResetSchema = z.object({
  identifier: identifierSchema,
});
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.string()),
  status: z.enum(['pending', 'active', 'suspended', 'deleted']),
  locale: z.string(),
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  createdAt: z.string(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;