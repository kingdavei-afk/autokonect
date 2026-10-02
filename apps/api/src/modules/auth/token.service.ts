import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { sql, type Db } from '@adkcars/database';

import type { AppConfig } from '../../common/config/env.validation';
import { APP_CONFIG, DATABASE } from '../../common/tokens';

/** Roles reconnus (CDCS 5.3). */
export type UserRole = 'client' | 'owner' | 'agency' | 'driver' | 'admin';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Duree de validite de l accessToken, en secondes. */
  expiresIn: number;
}

interface AccessTokenPayload {
  sub: string;
  roles: string[];
  /** Discriminant : un jeton d acces refuse en jeton de rafraichissement. */
  typ: 'access';
  jti: string;
}

interface Duration {
  seconds: number;
}

/** Convertit `15m`, `30d`, `90s` en secondes. */
function parseDuration(value: string): Duration {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());

  if (!match) {
    throw new Error(`Duree invalide : "${value}". Format attendu : 30s, 15m, 24h, 30d.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3_600 : 86_400;

  return { seconds: amount * factor };
}

/**
 * Emission et revocation des jetons.
 *
 * Deux choix de conception, conformes a CDCS 12.2 :
 *
 * 1. **Un jeton d acces JWT** (court, 15 min) : verifie sans appel
 *    base de donnees, donc rapide pour chaque requete.
 *
 * 2. **Un jeton de rafraichissement OPAQUE** (aleatoire, 48 octets) et
 *    non un JWT. Un JWT est verifiable sans base, donc non revocable :
 *    apres un changement de mot de passe, il resterait valide. Un jeton
 *    opaque se reference en base et se revoque a la volee.
 *
 * L'empreinte stockee est un SHA-256. Ce choix est deliberement
 * different de celui du mot de passe : un jeton de rafraichissement
 * tire 384 bits d'entropie, il n'est donc pas devinable et ne
 * benefitted pas d'un hachage lent. Argon2 y serait contre-productif.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  // ------------------------------------------------------------------
  // Jetons d'acces
  // ------------------------------------------------------------------

  get accessTtlSeconds(): number {
    return parseDuration(process.env['JWT_ACCESS_TTL'] ?? '15m').seconds;
  }

  private get refreshTtlSeconds(): number {
    return parseDuration(process.env['JWT_REFRESH_TTL'] ?? '30d').seconds;
  }

  private get refreshTtlDays(): number {
    return Math.ceil(this.refreshTtlSeconds / 86_400);
  }

  // ------------------------------------------------------------------
  // Emission d'une paire
  // ------------------------------------------------------------------

  async issue(
    userId: string,
    roles: string[],
    context: { ip?: string | null; userAgent?: string | null; deviceLabel?: string | null },
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(refreshToken);
    const jti = randomBytes(16).toString('hex');

    await sql`
      INSERT INTO auth_refresh_token
        (user_id, token_hash, device_label, ip, user_agent, expires_at, issued_at)
      VALUES (
        ${userId},
        ${tokenHash},
        ${context.deviceLabel ?? null},
        ${context.ip ?? null},
        ${context.userAgent?.slice(0, 512) ?? null},
        now() + ${sql.raw(`interval '${this.refreshTtlDays} days'`)},
        now()
      )
    `.execute(this.db);

    const accessToken = await this.signAccessToken(userId, roles, jti);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
    };
  }

  private async signAccessToken(
    subject: string,
    roles: string[],
    jti: string,
  ): Promise<string> {
    const payload: AccessTokenPayload = { sub: subject, roles, typ: 'access', jti };

    return this.jwt.signAsync(payload, {
      secret: process.env['JWT_ACCESS_SECRET'],
      expiresIn: this.accessTtlSeconds,
      issuer: 'adkcars.api',
      audience: 'adkcars.app',
    });
  }

  /** Verifie la signature et les registres du jeton d acces. */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: process.env['JWT_ACCESS_SECRET'],
      issuer: 'adkcars.api',
      audience: 'adkcars.app',
    });

    if (payload.typ !== 'access') {
      throw new Error('type_de_jeton_inattendu');
    }
    return payload;
  }

  // ------------------------------------------------------------------
  // Rafraichissement avec detection de reutilisation
  // ------------------------------------------------------------------

  /**
   * Rotation : le jeton presente est revoque et remplace.
   *
   * Si un jeton DEJA REVOQUE est represente, cela signifie qu'il a ete
   * vole : on revoque alors TOUTE la serie de jetons de l'utilisateur.
   * C'est la seule facon sure de reacting a un vol, puisque le voleur
   * et la victime utilisent le meme jeton.
   */
  async refresh(
    presentedToken: string,
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<TokenPair> {
    const tokenHash = this.hashToken(presentedToken);

    const result = await sql<{
      id: string;
      user_id: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>`
      SELECT id, user_id, revoked_at, expires_at
      FROM auth_refresh_token
      WHERE token_hash = ${tokenHash}
    `.execute(this.db);

    const row = result.rows[0];

    if (!row) {
      // Jeton inconnu : soit il est forge, soit la serie a deja ete
      // purgee. Aucune information ne doit etre communiquee sur lequel.
      throw new TokenReuseError();
    }

    if (row.revoked_at) {
      await this.revokeAllForUser(row.user_id);
      throw new TokenReuseError();
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new TokenExpiredError();
    }

    const roles = await this.rolesOf(row.user_id);

    if (roles === null) {
      // Le compte a ete supprime depuis l'emission du jeton.
      await this.revokeAllForUser(row.user_id);
      throw new TokenReuseError();
    }

    await sql`
      UPDATE auth_refresh_token
      SET revoked_at = now()
      WHERE id = ${row.id}
    `.execute(this.db);

    const refreshToken = randomBytes(48).toString('base64url');
    const jti = randomBytes(16).toString('hex');

    await sql`
      INSERT INTO auth_refresh_token
        (user_id, token_hash, ip, user_agent, expires_at, issued_at)
      VALUES (
        ${row.user_id},
        ${this.hashToken(refreshToken)},
        ${context.ip ?? null},
        ${context.userAgent?.slice(0, 512) ?? null},
        now() + ${sql.raw(`interval '${this.refreshTtlDays} days'`)},
        now()
      )
    `.execute(this.db);

    const accessToken = await this.signAccessToken(row.user_id, roles, jti);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
    };
  }

  private async rolesOf(userId: string): Promise<string[] | null> {
    const result = await sql<{ roles: string[]; status: string }>`
      SELECT roles, status FROM "user" WHERE id = ${userId} AND deleted_at IS NULL
    `.execute(this.db);

    const row = result.rows[0];
    if (!row) return null;
    if (row.status === 'suspended' || row.status === 'deleted') return null;

    return row.roles ?? [];
  }

  // ------------------------------------------------------------------
  // Revocation
  // ------------------------------------------------------------------

  async revoke(presentedToken: string): Promise<void> {
    await sql`
      UPDATE auth_refresh_token
      SET revoked_at = now()
      WHERE token_hash = ${this.hashToken(presentedToken)}
        AND revoked_at IS NULL
    `.execute(this.db);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await sql`
      UPDATE auth_refresh_token
      SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `.execute(this.db);
  }

  /** Supprime les jetons expires : tache de maintenance planifiee. */
  async purgeExpired(): Promise<number> {
    const result = await sql`
      DELETE FROM auth_refresh_token WHERE expires_at < now()
    `.execute(this.db);

    return Number(result.numAffectedRows ?? 0n);
  }

  // ------------------------------------------------------------------
  // Empreinte
  // ------------------------------------------------------------------

  /**
   * SHA-256 du jeton en clair.
   *
   * La colonne `token_hash` porte une contrainte d'unicite : une
   * collision est donc impossible, et la recherche est indexee.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  get isProduction(): boolean {
    return this.config.env === 'production';
  }
}

/** Jeton de rafraichissement deja consomme : vole probable. */
export class TokenReuseError extends Error {
  constructor() {
    super('jeton de rafraichissement reutilise');
    this.name = 'TokenReuseError';
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super('jeton de rafraichissement expire');
    this.name = 'TokenExpiredError';
  }
}