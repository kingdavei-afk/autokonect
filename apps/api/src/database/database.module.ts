import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { createDatabase, type Db } from '@adkcars/database';

import type { AppConfig } from '../common/config/env.validation';
import { APP_CONFIG, DATABASE } from '../common/tokens';

export { DATABASE } from '../common/tokens';

/**
 * Injection de la connexion Kysely.
 *
 * Toute l'application passe par ce provider : aucun module n'ouvre sa
 * propre connexion `pg`. Cela garantit un pool unique, des limites
 * coherentes et une fermeture propre a l'arret du processus.
 */

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Db => {
        const connectionString = process.env['DATABASE_URL'];

        if (!connectionString) {
          throw new Error(
            'DATABASE_URL absent : le service de base de donnees ne peut pas demarrer.',
          );
        }

        // Garde-fou CDCS 12.1 : l'application ne doit jamais utiliser le
        // role privilegie reserve aux migrations.
        if (
          process.env['DIRECT_DATABASE_URL'] &&
          connectionString === process.env['DIRECT_DATABASE_URL']
        ) {
          throw new Error(
            'DATABASE_URL est identique a DIRECT_DATABASE_URL. ' +
              "L'application doit utiliser un role restreint, distinct du role de migration.",
          );
        }

        return createDatabase({
          connectionString,
          max: resolvePoolSize(config),
          debug: config.log.level === 'debug',
        });
      },
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}

/**
 * Taille du pool de connexions.
 *
 * ------------------------------------------------------------------------
 * LE COMPTE FAIT PARTOUT (A-18)
 * ------------------------------------------------------------------------
 * La limite n'est pas « par application » mais « par base ». Sur
 * Supabase, le plan Micro autorise 60 connexions directes au total.
 *
 * Sur un hebergement a invocations ephemeres, chaque instance posee son
 * PROPRE pool. Avec un pool de 20 par instance et 5 instances
 * simultanees, la base refuse des connexions bien avant que la charge ne
 * soit importante : le service echoue avec une erreur de pool vide, qui
 * ressemble a une panne alors que la cause est un exces de connexions.
 *
 * D'ou un pool minuscule cote application : chaque instance ne traite
 * qu'une requete a la fois de toute facon. `DATABASE_POOL_MAX` permet
 * d'ajuster sans redemarrer quoi que ce soit.
 */
function resolvePoolSize(config: AppConfig): number {
  const configured = Number(process.env['DATABASE_POOL_MAX'] ?? 0);

  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, 10);
  }

  // Hebergement a invocations ephemeres : pool minimal.
  if (process.env['VERCEL'] === '1' || process.env['AWS_LAMBDA_FUNCTION_NAME']) {
    return 1;
  }

  return config.env === 'production' ? 10 : 5;
}

/**
 * Ferme proprement le pool de connexions a l'arret.
 *
 * Sans cela, un redemarrage en cours de deploiement laisse des
 * connexions ouvertes et le deploiement echoue apres plusieurs
 * tentatives (CDCS 11.4).
 */
@Injectable()
export class DatabaseShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.config.env === 'test') return;

    await this.db.destroy();
  }
}