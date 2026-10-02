import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppInfoService } from './app-info.service';
import { ConfigModule } from './common/config/config.module';
import { DatabaseModule, DatabaseShutdown } from './database/database.module';
import { HealthModule } from './health/health.module';

@Module({
  // ConfigModule en premier : il valide l'environnement et fige la
  // configuration avant que tout autre module ne soit instancie.
  imports: [ConfigModule, DatabaseModule, HealthModule],
  controllers: [AppController],
  providers: [AppInfoService, DatabaseShutdown],
})
export class AppModule {}