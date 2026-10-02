import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { ConfigModule } from './common/config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';

/**
 * Ordre d'importation : ConfigModule d'abord, car il valide
 * l'environnement et fige la configuration avant toute instanciation.
 *
 * `ThrottlerGuard` est enregistre AVANT le garde JWT afin que la
 * limitation de debit s'applique aussi aux routes publiques
 * d'authentification, qui sont precisement les plus exposees.
 */
@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: Number(process.env['THROTTLE_TTL_SECONDS'] ?? 60) * 1_000,
        limit: Number(process.env['THROTTLE_LIMIT_SHORT'] ?? 20),
      },
      {
        name: 'medium',
        ttl: Number(process.env['THROTTLE_TTL_SECONDS'] ?? 60) * 60_000,
        limit: Number(process.env['THROTTLE_LIMIT_MEDIUM'] ?? 100),
      },
    ]),
    DatabaseModule,
    NotificationsModule,
    AuthModule,
    VehiclesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}