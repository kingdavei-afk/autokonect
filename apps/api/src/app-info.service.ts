import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from './common/config/config.module';

/**
 * Decrit l'API : nom, version, surface disponible.
 *
 * La liste des points d'entree est centralisee ici afin que la racine
 * de l'API ne derive pas de la surface reelle du service.
 */
@Injectable()
export class AppInfoService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  describe(): {
    name: string;
    version: string;
    environment: string;
    documentation: string;
    endpoints: Record<string, string>;
  } {
    const { name, version } = this.config.app;

    return {
      name,
      version,
      environment: this.config.env,
      documentation: '/docs',
      endpoints: {
        health: '/health',
        liveness: '/health/live',
        readiness: '/health/ready',
      },
    };
  }
}