import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';

import { ConfigModule } from './common/config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { ThrottlerConfigModule } from './common/throttler/throttler-config.module';
import { AuthModule } from './modules/auth/auth.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { AdminVehiclesModule } from './modules/admin-vehicles/admin-vehicles.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

/**
 * Ordre d'importation : ConfigModule d'abord, car il valide
 * l'environnement avant toute instanciation.
 *
 * `ThrottlerConfigModule` est global et porte a la fois la
 * configuration des limites et leur stockage partage (voir le module
 * pour pourquoi il est isole).
 *
 * `ThrottlerGuard` passe AVANT le garde JWT : la limitation de debit
 * s'applique aussi aux routes publiques d'authentification, qui sont
 * precisement les plus exposees.
 */
@Module({
  imports: [
    ConfigModule,
    ThrottlerConfigModule,
    DatabaseModule,
    NotificationsModule,
    AuthModule,
    VehiclesModule,
    AdminVehiclesModule,
    RealtimeModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
