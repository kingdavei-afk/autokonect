import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { APP_CONFIG, type AppConfig } from '../common/config/config.module';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { StructuredLogger } from '../common/logger/structured-logger';
import { RequestContextMiddleware } from '../common/middleware/request-context.middleware';

/**
 * Options communes aux deux points d'entree.
 *
 * ------------------------------------------------------------------------
 * `abortOnError: false` — CE N'EST PAS UN DETAIL
 * ------------------------------------------------------------------------
 * Par defaut, `NestFactory.create` enveloppe l'initialisation dans une
 * `ExceptionsZone` qui appelle `process.exit(1)` des la moindre erreur,
 * **sans rien imprimer**. Concretement : le processus disparait, le
 * code de sortie est 1, et la cause est introuvable.
 *
 * C'est exactement le mode de defaillance le plus couteux qui soit :
 * aucune trace, aucun message, aucune piste. Cela a masque, sur ce
 * projet, une erreur de resolution d'injection pendant une heure de
 * developpement — l'ecran ne montrait qu'une sortie de code.
 *
 * Avec `abortOnError: false`, l'erreur remonte jusqu'a `main.ts`, qui
 * la journalise en JSON avant de quitter. Le principe du projet
 * (CDCS 12.1 : refuser de demarrer bruyamment plutot qu'echouer
 * obscurement) s'applique aussi a l'echec lui-meme.
 */
export const NEST_FACTORY_OPTIONS = {
  logger: false as const,
  bufferLogs: true,
  abortOnError: false,

  /**
   * Copie des OCTETS RECUS du corps JSON, dans `request.rawBody`.
   *
   * La signature d un prestataire porte sur les octets, pas sur ce
   * qu un analyseur en ferait. `express.json()` transforme le corps en
   * objet : l ordre des champs, les espaces et l echappement changent,
   * et la signature ne correspond plus. Tout webhook legitime serait
   * alors refuse.
   *
   * L option se pose ICI, a la creation de l application, et non sur
   * `useBodyParser` : c est Nest qui la transmet a son analyseur, et
   * `body-parser` ignore silencieusement un nom qu il ne connait pas.
   * Placee au mauvais endroit, elle ne produit ni erreur ni avertissement
   * — l application demarre normalement et refuse tous les webhooks. C est
   * le pire defaut de configuration possible : silencieux et constant, on
   * ne le distingue pas d un prestataire casse.
   *
   * Elle est dans les options PARTAGEES, donc appliquees par les deux
   * points d entree — le serveur autonome et la fonction serverless.
   * Sinon les deux produiraient des comportements differents, dont on
   * decouvrirait la difference a l hebergement.
   *
   * Cout : une copie de chaque corps JSON en memoire. La limite de taille
   * s'applique toujours, et seule la route de webhook la lit.
   */
  rawBody: true,
};

/**
 * Configuration partagee entre le serveur autonome et la fonction
 * serverless.
 *
 * ------------------------------------------------------------------------
 * POURQUOI UN FICHIER COMMUN
 * ------------------------------------------------------------------------
 * Les deux points d'entree — `main.ts` (serveur) et
 * `bootstrap/vercel-handler.ts` (fonction Vercel) — doivent produire
 * EXACTEMENT la meme application.
 *
 * Dupliquer cette configuration serait le pire des choix : les deux
 * copies divergent des la premiere evolution de l'une d'elles, et rien
 * ne le signale. Le symptome n'apparaitrait qu'en production, sur un
 * seul des deux environnements, generalement le moins surveille.
 *
 * Toute divergence serait donc invisible jusqu'a la panne. D'ou un
 * point unique de configuration.
 */
export async function configureApp(app: NestExpressApplication): Promise<AppConfig> {
  const config = app.get<AppConfig>(APP_CONFIG);

  // StructuredLogger est transient : il faut resolve() et non get().
  const logger = (await app.resolve(StructuredLogger)).setContext('Bootstrap');
  app.useLogger(logger);

  // ---- identifiant de correlation -----------------------------------
  // Premier, avant toute autre chose : tout journal emis ensuite, y
  // compris celui d'une erreur de routage, porte le request_id.
  app.use(new RequestContextMiddleware().use);

  // ---- en-tetes de securite (CDCS 11.5) ----------------------------
  app.disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'geolocation=(self), camera=()');
    next();
  });

  // ---- CORS explicite : jamais de joker en production ---------------
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'idempotency-key'],
    exposedHeaders: ['x-request-id'],
    maxAge: 86_400,
  });

  // ---- format d'erreur unique ----------------------------------------
  app.useGlobalFilters(await app.resolve(AllExceptionsFilter));

  // ---- confiance envers le reverse proxy ----------------------------
  // Necessaire pour que la limitation de debit voie la vraie IP du
  // client. Sur Vercel, `x-forwarded-for` est impose par la plateforme
  // et non transmis tel quel depuis le client : on peut donc lui faire
  // confiance. Ailleurs, un seul saut est presume.
  app.set('trust proxy', process.env['VERCEL'] === '1' ? true : 1);

  return config;
}
