import { Global, Module } from '@nestjs/common';

import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

/**
 * Transport temps reel.
 *
 * Le module est global pour une raison precise : n'importe quel module
 * metier doit pouvoir publier un evenement sans avoir a importer ce
 * module. Un bus d'evenements duplique dans chaque module metier
 * divergerait, et c'est exactement le type de divergence qui fait
 * qu'une reservation confirmee ne previent personne.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
