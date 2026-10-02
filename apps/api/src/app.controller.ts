import { Controller, Get } from '@nestjs/common';

import { Public } from './common/decorators/public.decorator';
import { AppInfoService } from './app-info.service';

/**
 * Racine de l'API.
 *
 * Publique par construction : elle sert de point d'entree pour decouvrir
 * la surface disponible.
 */
@Controller()
export class AppController {
  constructor(private readonly info: AppInfoService) {}

  @Public()
  @Get()
  root(): {
    name: string;
    version: string;
    environment: string;
    documentation: string;
    endpoints: Record<string, string>;
  } {
    return this.info.describe();
  }
}