import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import {
  buildPagination,
  createVehicleSchema,
  vehicleDetailSchema,
  vehicleSummarySchema,
  paginated,
  updateVehicleSchema,
  uploadDocumentSchema,
  vehicleSearchSchema,
  type CreateVehicleInput,
  type UpdateVehicleInput,
  type UploadDocumentInput,
  type VehicleSearchInput,
} from '@adkcars/contracts';

import { zodArrayResponse, zodResponse } from '../../common/interceptors/zod-response.interceptor';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, RolesGuard, type AuthenticatedUser } from '../auth/auth.guards';
import { VehiclesService } from './vehicles.service';

/**
 * Surface du catalogue vehicule.
 *
 * Aucun decorateur `@Public` : la lecture du catalogue exige un
 * compte. C'est un choix produit assumé — un vehiculier qui consulte
 * le catalogue sans compte n'a aucune raison de le faire — et il
 * simplifie la lutte contre le scraping (CDCS 12.4).
 */
@Controller('vehicles')
@UseGuards(RolesGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  // ------------------------------------------------------------------
  // Recherche
  // ------------------------------------------------------------------

  /**
   * Recherche de vehicules publies.
   *
   * Pagination limitee a 50 resultats par page : au-dela, le
   * navigateur et la connexion mobile ne tiennent plus la charge
   * (CDCS 11.3, contrainte terrain).
   */
  // La sortie est verifiee contre son schema : sans cela, un mapper
  // oublie un champ sans que rien ne le signale, et l'interface
  // affiche un zero la ou il devrait y avoir un montant.
  @Get()
  // La recherche renvoie une ENVELOPPE `{ items, pagination }`, pas un
  // tableau : c'est donc l enveloppe complete qui est validee, ce qui
  // verifie au passage que la pagination est complete.
  @UseInterceptors(zodResponse(paginated(vehicleSummarySchema)))
  async search(@Query(zodPipe(vehicleSearchSchema)) input: VehicleSearchInput) {
    return this.vehicles.search(input);
  }

  /**
   * Vehicules de l'utilisateur connecte.
   *
   * Declare AVANT `:id` : sans cela, un UUID passerait dans le
   * parametre de route et la liste ne serait jamais atteinte.
   */
  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser) {
    return { items: await this.vehicles.listMine(user) };
  }

  /** Verifie la completude documentaire avant soumission. */
  @Get(':id/publication-readiness')
  async readiness(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehicles.publicationReadiness(id);
  }

  @Get(':id')
  @UseInterceptors(zodResponse(vehicleDetailSchema))
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehicles.findOne(id, user);
  }

  // ------------------------------------------------------------------
  // Ecriture
  // ------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(zodPipe(createVehicleSchema)) input: CreateVehicleInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehicles.create(input, user);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(updateVehicleSchema)) input: UpdateVehicleInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehicles.update(id, input, user);
  }

  /**
   * Attache ou remplace un document de conformite.
   *
   * La verification du fichier lui-meme (type MIME reel, taille,
   * contenu) n'est pas faite ici : elle releve du service de stockage,
   * qui n'est pas encore branche (CDCS 12.8). Le point est signale
   * dans les travaux restants.
   */
  @Post(':id/documents')
  @HttpCode(HttpStatus.OK)
  async attachDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(uploadDocumentSchema)) input: UploadDocumentInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehicles.attachDocument(id, input, user);
  }

  /** Soumet le vehicule a validation par un administrateur. */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.vehicles.submitForReview(id, user);
  }
}

// Export du schema de pagination pour les tests d'integration.
export { buildPagination };