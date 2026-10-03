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
  availabilityQuerySchema,
  bookingFilterSchema,
  cancelBookingSchema,
  createBookingSchema,
  transitionBookingSchema,
  type AvailabilityQueryInput,
  type BookingFilterInput,
  type CancelBookingInput,
  type CreateBookingInput,
  type TransitionBookingInput,
} from '@adkcars/contracts';

import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, RolesGuard, type AuthenticatedUser } from '../auth/auth.guards';
import { BookingService } from './booking.service';

/**
 * Surface de la reservation (CDCS 8).
 *
 * Aucun decorateur `@Public` : une reservation sans compte n'a aucun
 * sens — elle n'a ni client, ni reference, ni moyen d'etre tracee.
 *
 * `RolesGuard` est pose au controleur : c'est le service qui applique la
 * regle de propriete, et lui seul. Le garde verifie les roles declares,
 * pas l'appartenance d'une reservation a une personne.
 */
@Controller('bookings')
@UseGuards(RolesGuard)
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  // ------------------------------------------------------------------
  // Creation
  // ------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(zodPipe(createBookingSchema)) input: CreateBookingInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bookings.create(input, actor);
  }

  // ------------------------------------------------------------------
  // Lecture
  // ------------------------------------------------------------------

  /**
   * Reservations visibles par l'acteur : les siennes en tant que
   * client, celles de son parc en tant que fournisseur, toutes en tant
   * qu'administrateur.
   */
  @Get()
  list(
    @Query(zodPipe(bookingFilterSchema)) filter: BookingFilterInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bookings.list(filter, actor);
  }

  /**
   * Disponibilite d'un vehicule sur une plage.
   *
   * Cette route ne revele que la DISPONIBILITE, jamais les reservations
   * existantes : un concurrent ne doit pas pouvoir deduire le carnet de
   * commandes d'un vehicule en interrogeant les creneaux refuses. La
   * reponse dit « indisponible », jamais « reserve jusqu'au 14 ».
   *
   * ⚠️ Elle est declaree AVANT `@Get(':id')` : Nest apparie les routes
   * dans l'ordre de declaration, et `:id` capterait « vehicle » puis
   * echouerait sur la validation d'UUID.
   */
  @Get('vehicle/:vehicleId/availability')
  availability(
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Query(zodPipe(availabilityQuerySchema)) range: AvailabilityQueryInput,
  ) {
    return this.bookings.availability(vehicleId, range.startAt, range.endAt);
  }

  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bookings.detail(id, actor);
  }

  // ------------------------------------------------------------------
  // Transitions
  // ------------------------------------------------------------------

  /**
   * Transition d'etat generique.
   *
   * Reservee aux transitions qui ne portent pas d'effet financier :
   * demarrage, restitution, ouverture de litige. L'annulation et la
   * resolution de litige ont leurs propres routes, parce qu'elles
   * declenchent des operations que l'etat cible ne suffit pas a
   * decrire.
   */
  @Post(':id/transitions')
  @HttpCode(HttpStatus.OK)
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(transitionBookingSchema)) input: TransitionBookingInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bookings.transition(id, input, actor);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(cancelBookingSchema)) input: CancelBookingInput,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bookings.cancel(id, input, actor);
  }
}
