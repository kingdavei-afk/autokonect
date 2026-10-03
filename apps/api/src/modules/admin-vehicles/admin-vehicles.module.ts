import { Global, Module } from '@nestjs/common';

import { AdminVehiclesController } from './admin-vehicles.controller';
import { AdminVehiclesService } from './admin-vehicles.service';

@Global()
@Module({
  controllers: [AdminVehiclesController],
  providers: [AdminVehiclesService],
  exports: [AdminVehiclesService],
})
export class AdminVehiclesModule {}