import { Controller, Get, HttpCode, HttpException, HttpStatus } from '@nestjs/common';

import { Public } from '../common/decorators/public.decorator';

import { HealthService, type HealthReport } from './health.service';

/**
 * Sondes de sante.
 *
 * Ces routes sont publiques par construction : un orchestrator externe
 * doit pouvoir les appeler sans jeton. La protection est assuree par
 * le decorateur @Public, interprete par le garde global
 * d'authentification.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Vivacite : le processus repond-il ? Ne teste aucune dependance. */
  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): HealthReport {
    return this.health.liveness();
  }

  /** Disponibilite : toutes les dependances sont-elles joignables ? */
  @Public()
  @Get('ready')
  async ready(): Promise<HealthReport> {
    const report = await this.health.readiness();

    if (report.status === 'down') {
      // 503 : le processus vit mais ne doit pas recevoir de trafic.
      throw new HttpException(
        { code: 'SERVICE_UNAVAILABLE', message: 'Dependance indisponible.' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return report;
  }
}