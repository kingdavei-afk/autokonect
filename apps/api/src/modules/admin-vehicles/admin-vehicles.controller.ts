import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import {
  reviewDecisionSchema,
  reviewDocumentDecisionSchema,
  reviewQueueQuerySchema,
  type ReviewDecision,
  type ReviewDocumentDecision,
  type ReviewQueueQuery,
} from '@adkcars/contracts';

import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, Roles, RolesGuard, type AuthenticatedUser } from '../auth/auth.guards';
import { AdminVehiclesService } from './admin-vehicles.service';

/**
 * Back-office : file de validation des vehicules (CDCS 7.2, F-77).
 *
 * Toutes les routes exigent le role `admin`, verifie par `RolesGuard`.
 * Le role est teste COTE SERVEUR ; l'interface du back-office qui
 * n'affiche pas le menu ne constitue pas une protection (CDCS 12.3).
 */
@Controller('admin/vehicles')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminVehiclesController {
  constructor(private readonly admin: AdminVehiclesService) {}

  /** File d'attente, plus ancienne d'abord par defaut. */
  @Get()
  async queue(@Query(zodPipe(reviewQueueQuerySchema)) query: ReviewQueueQuery) {
    return this.admin.queue(query);
  }

  /** Vehicule complet, documents et blocages, pour examen. */
  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.reviewDetail(id);
  }

  /** Accepte ou rejette un document de conformite. */
  @Post(':id/documents/review')
  @HttpCode(HttpStatus.OK)
  async reviewDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(reviewDocumentDecisionSchema)) decision: ReviewDocumentDecision,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.admin.decideDocument(id, decision, user);
  }

  /** Valide (publie) ou refuse le vehicule. */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(reviewDecisionSchema)) decision: ReviewDecision,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.admin.decide(id, decision, user);
  }
}