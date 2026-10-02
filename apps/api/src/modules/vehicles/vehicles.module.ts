import { Global, Module } from '@nestjs/common';

import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Global()
@Module({
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}