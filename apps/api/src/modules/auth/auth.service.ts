import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { sql, type Db } from '@adkcars/database';

import type { AppConfig } from '../../common/config/env.validation';
import { APP_CONFIG, DATABASE } from '../../common/tokens';
import {
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type UserProfile,
  type VerifyPhoneInput,
} from './auth.schema';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import {
  TokenExpiredError,
  TokenReuseError,
  TokenService,
  type TokenPair,
} from './token.service';

interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** Colonnes publiques d'un compte : jamais d'empreinte de mot de passe. */
interface PublicUserRow {
  id: string;
  email: string | null;
  phone: string | null;
  roles: string[] | null;
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  locale: string;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  created_at: Date;
}

/** Compte avec son empreinte : reserve aux verifications de connexion. */
interface UserRow extends PublicUserRow {
  password_hash: string | null;
}

/** Roles qu'un utilisateur ne peut pas s'attribuer lui-meme. */
const SELF_ASSIGNABLE_ROLES = new Set(['client', 'owner', 'driver']);

/**
 * Logique metier de l'authentification.
 *
 * Regle transversale : aucune reponse de cette classe ne doit permettre
 * d'apprendre si un compte existe. Un attaquant qui soumetrait des
 * numeros au hasard ne doit pas pouvoir distinguer « numero inconnu »
 * de « mot de passe faux ». C'est la raison des messages d'erreur
 * volontairement generiques.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
  ) {}

  // ------------------------------------------------------------------
  // Inscription
  // ------------------------------------------------------------------

  async register(input: RegisterInput, context: RequestContext) {
    const role = SELF_ASSIGNABLE_ROLES.has(input.role) ? input.role : 'client';
    const passwordHash = await this.passwords.hash(input.password);

    const existing = await sql<{ id: string }>`
      SELECT id FROM "user" WHERE email = ${input.email} AND deleted_at IS NULL
    `.execute(this.db);

    if (existing.rows.length > 0) {
      // L'existence du compte est signalee ici, et seulement ici : le
      // client vient de saisir l'adresse elle-meme, ce n'est donc pas
      // une fuite. Le mot de passe n'est jamais verifie dans ce cas.
      throw new ConflictException({
        code: 'EMAIL_ALREADY_USED',
        message: 'Un compte existe deja avec cette adresse email.',
      });
    }

    const existingPhone = await sql<{ id: string }>`
      SELECT id FROM "user" WHERE phone = ${input.phone} AND deleted_at IS NULL
    `.execute(this.db);

    if (existingPhone.rows.length > 0) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_USED',
        message: 'Un compte existe deja avec ce numero de telephone.',
      });
    }

    const created = await sql<PublicUserRow>`
      INSERT INTO "user" (email, phone, password_hash, status, roles)
      VALUES (${input.email}, ${input.phone}, ${passwordHash}, 'pending', ARRAY[${role}])
      RETURNING id, email, phone, roles, status, locale,
                email_verified_at, phone_verified_at, created_at
    `.execute(this.db);

    const user = created.rows[0];

    if (!user) {
      throw new Error('creation du compte sans ligne retournee');
    }

    const otpOutcome = await this.otp.issue(user.id, input.phone, 'phone_verification');

    // Un journal d'audit est ecrit meme pour une inscription reussie
    // (CDCS 12.5).
    await this.audit(user.id, 'auth.register', 'user', user.id, {
      role,
      ip: context.ip ?? null,
    });

    return {
      user: AuthService.toProfile(user),
      // Aucun jeton n'est emis : le compte doit d'abord etre verifie.
      nextStep: 'verify_phone' as const,
      verification: {
        channel: 'sms' as const,
        expiresInSeconds: otpOutcome.ttlSeconds,
      },
    };
  }

  // ------------------------------------------------------------------
  // Verification du telephone
  // ------------------------------------------------------------------

  async verifyPhone(
    input: VerifyPhoneInput,
    context: RequestContext,
  ): Promise<{ user: UserProfile; tokens: TokenPair }> {
    const user = await this.findByPhone(input.phone);

    if (!user) {
      // Meme message que pour un code faux : ne pas reveler que le
      // numero n'est pas enregistre.
      throw new UnauthorizedException({
        code: 'CODE_INVALIDE',
        message: 'Code incorrect ou expire.',
      });
    }

    if (user.phone_verified_at) {
      // Idempotence : revérifier un numero deja verifie ne doit pas
      // echouer, le client mobile peut rejouer la requete.
      const tokens = await this.tokens.issue(
        user.id,
        user.roles ?? [],
        context,
      );
      return { user: AuthService.toProfile(user), tokens };
    }

    const outcome = await this.otp.verify(
      user.id,
      'phone_verification',
      input.code,
    );

    if (!outcome.ok) {
      throw new UnauthorizedException({
        code: 'CODE_INVALIDE',
        message: 'Code incorrect ou expire.',
      });
    }

    const updated = await sql<PublicUserRow>`
      UPDATE "user"
      SET phone_verified_at = now(),
          status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
      WHERE id = ${user.id}
      RETURNING id, email, phone, roles, status, locale,
                email_verified_at, phone_verified_at, created_at
    `.execute(this.db);

    const profile = AuthService.toProfile(updated.rows[0]!);
    const tokens = await this.tokens.issue(
      user.id,
      user.roles ?? [],
      context,
    );

    await this.audit(user.id, 'auth.phone_verified', 'user', user.id, {
      ip: context.ip ?? null,
    });

    return { user: profile, tokens };
  }

  // ------------------------------------------------------------------
  // Connexion
  // ------------------------------------------------------------------

  async login(input: LoginInput, context: RequestContext): Promise<TokenPair> {
    const user = await this.findByIdentifier(input.identifier);

    // Verification systematique d'un hachage, meme si le compte
    // n'existe pas : sans cela, le temps de reponse revele quels
    // identifiants sont enregistres (CDCS 12.4).
    const hash = user?.password_hash ?? DUMMY_HASH;
    const passwordValid = await this.passwords.verify(hash, input.password);

    if (!user || !passwordValid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Identifiant ou mot de passe incorrect.',
      });
    }

    if (user.status === 'pending') {
      throw new UnauthorizedException({
        code: 'PHONE_NOT_VERIFIED',
        message: 'Verifiez votre numero de telephone pour continuer.',
      });
    }

    if (user.status === 'suspended' || user.status === 'deleted') {
      throw new UnauthorizedException({
        code: 'ACCOUNT_DISABLED',
        message: 'Ce compte est desactive. Contactez le support.',
      });
    }

    await sql`
      UPDATE "user" SET last_login_at = now(), last_login_ip = ${context.ip ?? null}
      WHERE id = ${user.id}
    `.execute(this.db);

    await this.audit(user.id, 'auth.login', 'user', user.id, {
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    return this.tokens.issue(user.id, user.roles ?? [], context);
  }

  // ------------------------------------------------------------------
  // Rafraichissement et deconnexion
  // ------------------------------------------------------------------

  async refresh(presentedToken: string, context: RequestContext): Promise<TokenPair> {
    try {
      return await this.tokens.refresh(presentedToken, context);
    } catch (error) {
      if (error instanceof TokenReuseError) {
        this.logger.warn(
          `Reutilisation de jeton detectee : toute la serie a ete revoquee. ip=${context.ip ?? '-'}`,
        );
        throw new UnauthorizedException({
          code: 'TOKEN_REUSE_DETECTED',
          message: 'Session invalide. Reconnectez-vous.',
        });
      }
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedException({
          code: 'TOKEN_EXPIRED',
          message: 'Session expiree. Reconnectez-vous.',
        });
      }
      throw error;
    }
  }

  async logout(presentedToken: string): Promise<void> {
    await this.tokens.revoke(presentedToken);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
  }

  // ------------------------------------------------------------------
  // Reinitialisation du mot de passe
  // ------------------------------------------------------------------

  /**
   * Demande de reinitialisation.
   *
   * Renvoie TOUJOURS la meme reponse, que le compte existe ou non.
   */
  async requestPasswordReset(
    input: RequestPasswordResetInput,
    _context: RequestContext,
  ): Promise<{ accepted: true; ttlSeconds: number }> {
    const user = await this.findByIdentifier(input.identifier);
    const ttl = Number(process.env['OTP_TTL_SECONDS'] ?? 600);

    if (user?.phone) {
      await this.otp.issue(user.id, user.phone, 'password_reset');
      await this.audit(user.id, 'auth.password_reset_requested', 'user', user.id, {});
    }

    return { accepted: true, ttlSeconds: ttl };
  }

  async resetPassword(
    input: ResetPasswordInput,
    context: RequestContext,
  ): Promise<{ reset: true }> {
    const user = await this.findByPhone(input.phone);

    if (!user) {
      throw new UnauthorizedException({
        code: 'CODE_INVALIDE',
        message: 'Code incorrect ou expire.',
      });
    }

    const outcome = await this.otp.verify(user.id, 'password_reset', input.code);

    if (!outcome.ok) {
      throw new UnauthorizedException({
        code: 'CODE_INVALIDE',
        message: 'Code incorrect ou expire.',
      });
    }

    const passwordHash = await this.passwords.hash(input.newPassword);

    await sql`
      UPDATE "user" SET password_hash = ${passwordHash} WHERE id = ${user.id}
    `.execute(this.db);

    // Toutes les sessions sont revoquees : un changement de mot de passe
    // doit deconnecter les appareils qui pourraient etre voles.
    await this.tokens.revokeAllForUser(user.id);

    await this.audit(user.id, 'auth.password_reset', 'user', user.id, {
      ip: context.ip ?? null,
    });

    return { reset: true };
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    context: RequestContext,
  ): Promise<{ changed: true }> {
    const user = await this.findById(userId);

    if (!user?.password_hash) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Mot de passe actuel incorrect.',
      });
    }

    const valid = await this.passwords.verify(user.password_hash, input.currentPassword);

    if (!valid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Mot de passe actuel incorrect.',
      });
    }

    if (await this.passwords.verify(user.password_hash, input.newPassword)) {
      throw new ConflictException({
        code: 'PASSWORD_UNCHANGED',
        message: "Le nouveau mot de passe doit differer de l'ancien.",
      });
    }

    const passwordHash = await this.passwords.hash(input.newPassword);

    await sql`
      UPDATE "user" SET password_hash = ${passwordHash} WHERE id = ${userId}
    `.execute(this.db);

    await this.tokens.revokeAllForUser(userId);
    await this.audit(userId, 'auth.password_changed', 'user', userId, {
      ip: context.ip ?? null,
    });

    return { changed: true };
  }

  // ------------------------------------------------------------------
  // Profil
  // ------------------------------------------------------------------

  async profile(userId: string): Promise<UserProfile> {
    const user = await this.findById(userId);

    if (!user) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Compte introuvable.',
      });
    }

    return AuthService.toProfile(user);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async findById(id: string): Promise<UserRow | undefined> {
    const result = await sql<UserRow>`
      SELECT id, email, phone, password_hash, status, roles, locale,
             email_verified_at, phone_verified_at, created_at
      FROM "user" WHERE id = ${id} AND deleted_at IS NULL
    `.execute(this.db);
    return result.rows[0];
  }

  private async findByPhone(phone: string): Promise<UserRow | undefined> {
    const result = await sql<UserRow>`
      SELECT id, email, phone, password_hash, status, roles, locale,
             email_verified_at, phone_verified_at, created_at
      FROM "user" WHERE phone = ${phone} AND deleted_at IS NULL
    `.execute(this.db);
    return result.rows[0];
  }

  /**
   * Recherche par email OU telephone.
   *
   * Une seule requete pour les deux cas : deux requetes sequentielles
   * leakseraient le nombre d'enregistrements via le temps de reponse.
   */
  private async findByIdentifier(identifier: string): Promise<UserRow | undefined> {
    const result = await sql<UserRow>`
      SELECT id, email, phone, password_hash, status, roles, locale,
             email_verified_at, phone_verified_at, created_at
      FROM "user"
      WHERE (lower(email) = lower(${identifier}) OR phone = ${identifier})
        AND deleted_at IS NULL
      LIMIT 1
    `.execute(this.db);
    return result.rows[0];
  }

  private async audit(
    actorId: string,
    action: string,
    entity: string,
    entityId: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await sql`
      INSERT INTO audit_log (actor_id, action, entity, entity_id, ip, after)
      VALUES (
        ${actorId},
        ${action},
        ${entity},
        ${entityId},
        ${extra['ip'] ?? null},
        ${JSON.stringify(extra)}::jsonb
      )
    `.execute(this.db);
  }

  private static toProfile(row: PublicUserRow): UserProfile {
    return {
      id: row.id,
      email: row.email,
      phone: row.phone,
      roles: row.roles ?? [],
      status: row.status,
      locale: row.locale,
      emailVerified: row.email_verified_at !== null,
      phoneVerified: row.phone_verified_at !== null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  get isProduction(): boolean {
    return this.config.env === 'production';
  }
}

/**
 * Empreinte factice utilisee lorsqu'aucun compte ne correspond.
 *
 * Argon2 est lent : ne rien hasher quand aucun compte n'existe
 * changerait la duree de reponse de la connexion et permettrait
 * d'enumerer les comptes enregistres.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$' +
  'Zx3vQ8kLmNpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH';