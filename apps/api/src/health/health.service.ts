import { Inject, Injectable } from '@nestjs/common';

import { ping, type Db } from '@adkcars/database';

import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../common/config/env.validation';

export type CheckStatus = 'up' | 'down';

export interface CheckResult {
  status: CheckStatus;
  /** Latence observee, en millisecondes. */
  latencyMs: number;
  message?: string;
}

export interface HealthReport {
  status: CheckStatus;
  uptimeSeconds: number;
  version: string;
  environment: string;
  checks: Record<string, CheckResult>;
  timestamp: string;
}

const startedAt = Date.now();

/**
 * Sante du service.
 *
 * Deux sondes distinctes, conformement a CDCS 11.4 :
 *  - `live`  : le processus repond-il ? Utilisee par le redemarrage.
 *  - `ready` : toutes les dependances sont-elles joignables ?
 *               Utilisee par le routage du trafic.
 *
 * Confondre les deux est une cause classique d'interruption de service :
 * un arret de base de donnee ne doit pas declencher un redemarrage en
 * boucle de toute la flotte.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Sonde de vivacite : ne teste aucune dependance. */
  liveness(): HealthReport {
    return {
      status: 'up',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: this.config.app.version,
      environment: this.config.env,
      checks: {},
      timestamp: new Date().toISOString(),
    };
  }

  /** Sonde de disponibilite : teste la base de donnees. */
  async readiness(): Promise<HealthReport> {
    const checks: Record<string, CheckResult> = {};

    checks['database'] = await this.checkDatabase();

    const healthy = Object.values(checks).every((check) => check.status === 'up');

    return {
      status: healthy ? 'up' : 'down',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: this.config.app.version,
      environment: this.config.env,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<CheckResult> {
    const begin = performance.now();

    try {
      await ping(this.db);
      return { status: 'up', latencyMs: Math.round(performance.now() - begin) };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - begin),
        message: (error as Error).message,
      };
    }
  }
}