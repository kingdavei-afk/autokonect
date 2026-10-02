import { randomInt } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { sql, type Db } from '@adkcars/database';

import type { AppConfig } from '../../common/config/env.validation';
import { APP_CONFIG, DATABASE } from '../../common/tokens';
import { SMS_PROVIDER, type SmsSender, type SmsSendResult } from '../notifications/sms/sms.provider';
import { PasswordService } from './password.service';

/** Motifs de code OTP, alignes sur la contrainte `auth_otp.purpose`. */
export type OtpPurpose =
  | 'phone_verification'
  | 'login'
  | 'password_reset'
  | '2fa';

export interface OtpSendOutcome {
  sent: boolean;
  /** Delai de validite applique, en secondes. */
  ttlSeconds: number;
}

/**
 * Emission et verification des codes a usage unique.
 *
 * Decisions de securite :
 *
 * 1. **Le code n'est jamais stocke en clair.** Il est hache en Argon2 :
 *    un code a 6 chiffres n'a qu'un million de combinaisons, il doit
 *    donc etre traite comme un mot de passe.
 * 2. **Les tentatives sont comptees.** Au-dela du maximum, le code est
 *    consomme : un code a 6 chiffres ne resiste pas a une attaque en
 *    ligne, seulement a la limitation de debit.
 * 3. **Un seul code actif par motif.** L'emission d'un nouveau code
 *    invalide les precedents.
 * 4. **Le message ne revele pas si le compte existe**, pour eviter
 *    l'enumeration de comptes.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SMS_PROVIDER) private readonly sms: SmsSender,
    private readonly passwords: PasswordService,
  ) {}

  private get ttlSeconds(): number {
    return Number(process.env['OTP_TTL_SECONDS'] ?? 600);
  }

  private get maxAttempts(): number {
    return Number(process.env['OTP_MAX_ATTEMPTS'] ?? 3);
  }

  /**
   * Emet un code et l'envoie par SMS.
   * Ne leve pas d'erreur si l'envoi echoue : l'echec doit etre
   * journalise, pas remonté comme une erreur metier.
   */
  async issue(
    userId: string,
    phone: string,
    purpose: OtpPurpose,
  ): Promise<OtpSendOutcome> {
    // Un nouveau code invalide les precedents du meme motif.
    await sql`
      UPDATE auth_otp
      SET consumed_at = now()
      WHERE user_id = ${userId}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
    `.execute(this.db);

    const code = OtpService.generateCode();
    const codeHash = await this.passwords.hash(code);

    await sql`
      INSERT INTO auth_otp (user_id, purpose, code_hash, expires_at)
      VALUES (${userId}, ${purpose}, ${codeHash}, now() + ${sql.raw(`interval '${this.ttlSeconds} seconds'`)})
    `.execute(this.db);

    const result: SmsSendResult = await this.sms.send({
      to: phone,
      body: this.composeMessage(code, purpose),
      reference: `${purpose}:${userId}`,
    });

    if (!result.accepted) {
      // Journalise cote serveur ; le client recoit la meme reponse que
      // dans le cas nominal, pour ne rien reveler.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'otp.sms_echec',
          purpose,
          error: result.error,
        }),
      );
    }

    return { sent: true, ttlSeconds: this.ttlSeconds };
  }

  /**
   * Verifie un code.
   *
   * Renvoie un motif d'echec indistinct (`CODE_INVALIDE`) pour tout
   * ce qui n'est pas « code correct » : expiration, epuisement des
   * tentatives, code deja utilise, motif incorrect. Distinguer ces cas
   * aiderait un attaquant a optimiser ses essais.
   */
  async verify(
    userId: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await sql<{
      id: string;
      code_hash: string;
      attempts: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>`
      SELECT id, code_hash, attempts, expires_at, consumed_at
      FROM auth_otp
      WHERE user_id = ${userId} AND purpose = ${purpose} AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `.execute(this.db);

    const row = result.rows[0];

    if (!row) {
      return { ok: false, reason: 'CODE_INVALIDE' };
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.consume(row.id);
      return { ok: false, reason: 'CODE_INVALIDE' };
    }

    const valid = await this.passwords.verify(row.code_hash, code);

    if (!valid) {
      const attempts = row.attempts + 1;

      // Au-dela du maximum, le code est invalide : un code a 6 chiffres
      // ne resiste pas a un essai systematique sans limitation.
      if (attempts >= this.maxAttempts) {
        await this.consume(row.id);
      } else {
        await sql`
          UPDATE auth_otp SET attempts = ${attempts} WHERE id = ${row.id}
        `.execute(this.db);
      }

      return { ok: false, reason: 'CODE_INVALIDE' };
    }

    await this.consume(row.id);
    return { ok: true };
  }

  private async consume(id: string): Promise<void> {
    await sql`UPDATE auth_otp SET consumed_at = now() WHERE id = ${id}`.execute(
      this.db,
    );
  }

  /**
   * Code a 6 chiffres genere par rejection cryptographique.
   *
   * `Math.random()` est explicitement exclu : il n'est pas utilise pour
   * la securite. `crypto.randomInt` est sans biais et sans dependance.
   */
  static generateCode(): string {
    return randomInt(0, 1_000_000)
      .toString()
      .padStart(6, '0');
  }

  private composeMessage(code: string, purpose: OtpPurpose): string {
    switch (purpose) {
      case 'phone_verification':
        return `AdkCars : votre code de verification est ${code}. Valable ${Math.floor(this.ttlSeconds / 60)} minutes.`;
      case 'password_reset':
        return `AdkCars : code de reinitialisation ${code}. Ne le communiquez a personne.`;
      case 'login':
        return `AdkCars : votre code de connexion est ${code}.`;
      case '2fa':
        return `AdkCars : votre code de double authentification est ${code}.`;
    }
  }

  get isProduction(): boolean {
    return this.config.env === 'production';
  }
}