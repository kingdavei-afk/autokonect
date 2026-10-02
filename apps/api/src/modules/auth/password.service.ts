import { Inject, Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

import type { AppConfig } from '../../common/config/env.validation';
import { APP_CONFIG } from '../../common/tokens';

/**
 * Parametres de hachage.
 *
 * Memoire 19 MiB, temps 2, parallelisme 1 : valeurs minimales
 * conformes aux recommandations OWASP pour Argon2id. Elles sont
 * valides au demarrage par env.validation.ts, qui refuse un seuil
 * inferieur en production.
 */
interface ArgonOptions {
  algorithm: Algorithm;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Hachage et verification des secrets (mot de passe, code OTP).
 *
 * Argon2id plutot que bcrypt ou SHA : resistant aux attaques par GPU
 * et adapte au materiel disponible (CDCS 12.2).
 *
 * Les codes OTP sont egalement hachees : un code a 6 chiffres n'a que
 * un million de possibilites et ne doit donc JAMAIS etre stocke en
 * clair, meme pendant les dix minutes de validite.
 */
@Injectable()
export class PasswordService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get options(): ArgonOptions {
    return {
      algorithm: Algorithm.Argon2id,
      memoryCost: Number(process.env['ARGON2_MEMORY_COST'] ?? 19_456),
      timeCost: Number(process.env['ARGON2_TIME_COST'] ?? 2),
      parallelism: Number(process.env['ARGON2_PARALLELISM'] ?? 1),
    };
  }

  /** Produit une empreinte au format PHC `$argon2id$v=19$m=...,t=...,p=...`. */
  async hash(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      // Une empreinte corrompue ou un algorithme inconnu ne doit pas
      // faire tomber la requete : c'est un echec de verification.
      return false;
    }
  }

  /**
   * Comparaison a temps constant sur deux chaines de memes contraintes.
   *
   * Utilisee pour les jetons de rafraichissement, ou l'on compare des
   * empreintes SHA-256 : la comparaison par egalite classique
   * s'arrete des le premier octet different et permet de reconstruire
   * l'empreinte par mesure de temps.
   */
  constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  get isProduction(): boolean {
    return this.config.env === 'production';
  }
}