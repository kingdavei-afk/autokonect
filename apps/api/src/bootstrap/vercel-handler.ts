import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppModule } from '../app.module';
import { configureApp, NEST_FACTORY_OPTIONS } from './configure-app';

/**
 * ------------------------------------------------------------------------
 * Point d'entree Vercel (A-18)
 * ------------------------------------------------------------------------
 * Vercel invoque ce gestionnaire a chaque requete. L'application NestJS
 * est donc creee AU PREMIER APPEL et reutilisee pour les suivants, pendant
 * toute la duree de vie de l'instance.
 *
 * Le code vit dans `src/` et non dans `api/index.ts` pour une raison
 * concrete : `tsconfig.json` ne compile que `src/`. Un gestionnaire place
 * dans `api/` ne serait donc ni type verifie, ni couvert par les tests,
 * ni construit — il ne serait verifie qu'en production, au moment ou il
 * serait le plus couteux de le decouvrir. `api/index.ts` n'est qu'un
 * point d'entree d'une ligne.
 *
 * ------------------------------------------------------------------------
 * UNE SEULE INSTANCE, SANS ETAT PARTAGE
 * ------------------------------------------------------------------------
 * Une instance Vercel sert plusieurs requetes sequentielles, jamais
 * simultanement. Reutiliser l'application est donc sur, et c'est ce qui
 * evite de revalider la configuration et de rouvrir un pool de connexions
 * a chaque requete.
 *
 * Ce qui reste INTERDIT : conserver un etat en memoire entre deux
 * requetes. Une instance peut etre detruite sans preavis, et une autre
 * prend le relais ailleurs. Tout ce qui doit survivre est dans
 * PostgreSQL. C'est la raison pour laquelle le temps reel est passe de
 * Socket.IO a SSE (A-17), et pourquoi le limiteur de debit exige un
 * stockage partage.
 *
 * ------------------------------------------------------------------------
 * FLUX SSE ET DUREE D'EXECUTION
 * ------------------------------------------------------------------------
 * Un flux SSE est une reponse qui reste ouverte. Cela suppose Fluid
 * compute et une duree maximale superieure a la duree attendue du flux :
 * `vercel.json` fixe `maxDuration`. Une duree trop courte coupe le flux
 * en cours, et le client ne verrait jamais la fin.
 */

/** Instance Express deja initialisee, reutilisee entre les invocations. */
let cached: NestExpressApplication | null = null;

/** Demarrage en cours, pour ne pas initialiser deux fois en parallele. */
let starting: Promise<NestExpressApplication> | null = null;

async function getApp(): Promise<NestExpressApplication> {
  if (cached) return cached;

  // Deux requetes peuvent atteindre l'instance au meme instant. Sans ce
  // verrou, chacune creerait son application, donc son propre pool de
  // connexions, et l'une des deux serait abandonnee sans fermeture : des
  // connexions orphelines sur une base qui en autorise peu.
  starting ??= (async () => {
    const app = await NestFactory.create<NestExpressApplication>(
      AppModule,
      NEST_FACTORY_OPTIONS,
    );

    await configureApp(app);

    // `init()` et non `listen()` : aucun port n'est ouvert, la
    // configuration du serveur laisse la place a la fonction.
    await app.init();

    cached = app;
    return app;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const app = await getApp();
    app.getHttpAdapter().getInstance()(req, res);
  } catch (error) {
    // ------------------------------------------------------------------------
    // Echec de demarrage : la fonction doit repondre, pas disparaitre
    // ------------------------------------------------------------------------
    // Vercel traduirait une exception non geree en 500 sans corps, et
    // le message de la cause resterait invisible. C'est
    // reproductible : une variable d'environnement manquante ferait
    // echouer chaque invocation de facon opaque.
    const err = error as Error;

    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'fatal',
        msg: 'initialisation de la fonction impossible',
        error: err.message,
      })}\n`,
    );

    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json' });
    }

    res.end(
      JSON.stringify({
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: "Le service n'a pas pu demarrer. Verifiez la configuration.",
      }),
    );
  }
}
