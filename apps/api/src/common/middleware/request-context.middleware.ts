import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

declare module 'express' {
  interface Request {
    /** Identifiant de correlation, repris dans chaque ligne de journal. */
    requestId: string;
  }
}

/**
 * Attribue un identifiant de correlation a chaque requete et l'expose
 * dans l'en-tete de reponse `x-request-id`.
 *
 * Indispensable pour diagnostiquer un incident : sans cet identifiant,
 * relier le journal serveur a la demande utilisateur est impossible
 * (CDCS 11.8).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();

    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    next();
  }
}