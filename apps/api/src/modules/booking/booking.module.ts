import { Module } from '@nestjs/common';

import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

/**
 * Metier de la reservation (CDCS 8).
 *
 * Le service est exporte : le module Paiement, a venir, doit pouvoir
 * faire passer une reservation a l'etat `paid` sur confirmation du
 * paiement sans repasser par le controleur, et sans dupliquer la
 * verification de version qui empeche la course.
 *
 * Ce n'est pas un acces.public : toute reservation passant par le
 * service respecte le verrou optimiste, l'audit et le controle
 * d'acces.
 */
@Module({
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
