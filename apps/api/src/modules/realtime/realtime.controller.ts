import { Controller, Get, Sse } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.guards';
import { CurrentUser } from '../auth/auth.guards';
import { POLL_INTERVAL_MS, RealtimeService, type StreamEvent } from './realtime.service';

/**
 * Diffusion des evenements temps reel.
 *
 * La route est privee par defaut (CDCS 12.3) : le garde JWT global
 * s'applique, seul `@Public()` la rendrait accessible sans jeton.
 */
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  /**
   * Flux d'evenements de l'utilisateur authentifie.
   *
   * Les en-tetes necessaires a un flux SSE (`Content-Type`,
   * `Cache-Control`, `Connection`, `X-Accel-Buffering`) sont poses par
   * le gestionnaire SSE de Nest lui-meme. Les redeclarer ici serait
   *(double travail ET source de divergence) : si les deux divergeaient,
   * la correction porterait sur le mauvais des deux.
   */
  @Sse('events')
  events(
    @CurrentUser() user: AuthenticatedUser,
  ): import('rxjs').Observable<{ id: string; type: string; data: StreamEvent }> {
    return this.realtime.streamFor(user.id);
  }

  /**
   * Etat du transport temps reel.
   *
   * Utile au diagnostic : un client ou un exploitant peut verifier
   * quel transport est actif et sur quels intervalles il repose, sans
   * avoir a lire les journaux.
   */
  @Get('status')
  status(): {
    transport: 'sse';
    pollIntervalMs: number;
    socketIoAbandonne: boolean;
    raison: string;
  } {
    return {
      transport: 'sse',
      pollIntervalMs: POLL_INTERVAL_MS,
      socketIoAbandonne: true,
      raison:
        'Socket.IO abandonne : sur Vercel les connexions WebSocket sont ' +
        'plafonnees a 5 minutes et epinglees a une instance unique, ce qui ' +
        'rend le routage multi-instance impossible. Les evenements sont lus ' +
        'depuis la table notification.',
    };
  }
}
