import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { StructuredLogger } from '../logger/structured-logger';

interface ErrorBody {
  statusCode: number;
  /** Code stable, destine au client (jamais un message technique). */
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
  timestamp: string;
  path: string;
}

/**
 * Normalisation des erreurs en reponse JSON stable.
 *
 * Regle (CDCS 12.4) : le client ne recoit jamais de trace de pile, de
 * SQL ou de detail interne. Le client voit un code et un message ; le
 * journal serveur conserve le detail complet, correle par request_id.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(StructuredLogger) private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let code = 'INTERNAL_ERROR';
    let message = 'Une erreur interne est survenue.';
    let details: unknown;

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        message = payload;
        code = defaultCodeFor(status);
      } else if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        code = typeof record['code'] === 'string' ? record['code'] : defaultCodeFor(status);
        const rawMessage = record['message'];

        if (typeof rawMessage === 'string') {
          message = rawMessage;
        } else if (Array.isArray(rawMessage)) {
          // Erreurs de validation : detail par champ, surligne a la fois.
          message = 'Donnees invalides.';
          details = rawMessage;
        } else {
          message = exception.message;
        }

        // ------------------------------------------------------------------------
        // `details` FOURNI PAR LE SERVICE
        // ------------------------------------------------------------------------
        // Ce champ est un CONTRAT, pas une fuite : la liste des transitions
        // possibles d'une reservation, la version courante en cas de conflit.
        // Sans lui, le client recoit un « 409 » sans aucune indication de ce
        // qu'il peut faire, et il ne peut que reessayer a l'aveugle.
        //
        // Ce qui est autorise ici est strictement ce que le service a place
        // sous cette cle : des etats, des versions, des listes fermees. Le
        // filtre ne deballe rien d'autre — ni pile, ni SQL, ni structure de
        // base. Un service qui y mettait un detail technique le publierait
        // par accident ; c'est pourquoi la cle est unique et nommee.
        if (record['details'] !== undefined) {
          details = record['details'];
        }
      }
    } else {
      // Erreur non HTTP : c'est un defaut. Elle doit etre journalisee
      // integralement, sinon aucune trace ne subsiste et le diagnostic
      // devient impossible (CDCS 11.8).
      this.logUnexpected(request, status, exception);
    }

    const body: ErrorBody = {
      statusCode: status,
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    };

    response.status(status).json(body);
  }

  /** Journalise une erreur 5xx avec sa cause et sa pile. */
  private logUnexpected(
    request: Request,
    status: number,
    exception: unknown,
  ): void {
    const context = {
      requestId: request.requestId,
      method: request.method,
      path: request.originalUrl,
      status,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };

    if (exception instanceof Error) {
      this.logger.error('exception non geree', {
        ...context,
        name: exception.name,
        error: exception.message,
        stack: exception.stack?.split('\n').slice(0, 12).join('\n'),
      });
      return;
    }

    this.logger.error('exception non geree (non Error)', {
      ...context,
      received: typeof exception,
    });
  }
}

function defaultCodeFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
  }
}