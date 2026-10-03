import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { sql, type Db } from '@adkcars/database';
import { Observable } from 'rxjs';

import { APP_CONFIG, type AppConfig } from '../../common/config/config.module';
import { StructuredLogger } from '../../common/logger/structured-logger';
import { DATABASE } from '../../common/tokens';

/**
 * ------------------------------------------------------------------------
 * TEMPS REEL SANS SOCKET.IO (A-17)
 * ------------------------------------------------------------------------
 * Le CDC prevoyait Socket.IO (CDCS 10.2). L'API etant hebergee sur
 * Vercel, dont les connexions WebSocket sont plafonnees a 5 minutes et
 * epinglees a une instance unique, Socket.IO n'y est pas exploitable.
 *
 * Le remplacement retenu est **Server-Sent Events (SSE)** :
 *
 *   | Critere                  | Socket.IO        | SSE                   |
 *   |--------------------------|------------------|-----------------------|
 *   | Sens                     | bidirectionnel   | serveur vers client   |
 *   | Conserve une connexion   | oui, par defaut  | **non**, par defaut   |
 *   | Reconnexion              | cote client      | native du navigateur  |
 *   | Cout d'infrastructure   | serveur + adapt. | nul                   |
 *
 * SSE est **unidirectional**, ce qui convient : tous nos cas d'usage
 * sont des notifications du serveur vers le client (statut de
 * reservation, message recu, resultat de paiement). Le client parle a
 * l'API par requetes HTTP ordinaires, ce qu'il fait deja.
 *
 * SSE est aussi plus robuste sur un reseau instable, ce qui est le cas
 * d'usage dominant a Abidjan : la reconnexion est native du cote
 * navigateur, alors qu'un client Socket.IO doit reconstruire lui-meme
 * sa connexion.
 *
 * ------------------------------------------------------------------------
 * SANS ETAT, PAR CONCEPTION
 * ------------------------------------------------------------------------
 * Aucun canal n'est conserve en memoire. Une instance Vercel est
 * ephemere : y loger un canal produirait des notifications perdues des
 * qu'une autre instance repond.
 *
 * Les evenements sont donc **lus depuis la base** (table `notification`),
 * par interrogation periodique. C'est plus lent qu'un bus, mais c'est
 * correct : la source de verite est la base, et aucune notification
 * n'est perdue. Le cout tient a la frequence d'interrogation, pas a la
 * complexite du code.
 */

/** Intervalle de lecture des evenements, en millisecondes. */
export const POLL_INTERVAL_MS = Number(process.env['SSE_POLL_INTERVAL_MS'] ?? 5_000);

/** Nombre maximum d'evenements renvayes par lot. */
const BATCH_SIZE = 50;

/** Profondeur de rejeu au reconnectement, sans en-tete `Last-Event-ID`. */
const REPLAY_WINDOW_MS = 60_000;

/** Forme des evenements tels qu'ils existent en base. */
interface NotificationRow {
  id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

/** Forme d'un evenement transmis au client. */
export interface StreamEvent {
  id: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class RealtimeService {
  private readonly logger: LoggerService;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.logger = new StructuredLogger(config).setContext('Realtime');
  }

  /**
   * Flux d'evenements d'un utilisateur.
   *
   * @param userId      destinataire
   * @param lastEventId valeur de l'en-tete `Last-Event-ID`, que le
   *                    navigateur renvoie automatiquement lors d'une
   *                    reconnexion. C'est ce qui rend la reprise sans
   *                    perte possible sans aucun etat cote serveur.
   */
  streamFor(userId: string, lastEventId?: string): Observable<{ id: string; type: string; data: StreamEvent }> {
    return new Observable<{ id: string; type: string; data: StreamEvent }>((subscriber) => {
      // Un identifiant d'evenement est un horodatage ISO ; tout autre
      // format est rejete plutot que lu hativement : un curseur mal
      // interprete ferait soit rejouer tout l'historique, soit perdre
      // des evenements sans que rien ne le signale.
      const cursor = new Date(
        lastEventId && /^\d{4}-\d{2}-\d{2}T/.test(lastEventId)
          ? lastEventId
          : new Date(Date.now() - REPLAY_WINDOW_MS).toISOString(),
      );

      let closed = false;

      const read = async (): Promise<void> => {
        if (closed) return;

        try {
          const events = await this.eventsSince(userId, cursor);

          for (const event of events) {
            subscriber.next({ id: event.createdAt, type: event.type, data: event });

            // Curseur avance sur l'horodatage le plus recent. Deux
            // evenements de la meme seconde ne peuvent pas non plus
            // faire avancer la date : le tri par `id` en second critere
            // les ordonne de facon stable.
            if (new Date(event.createdAt) > cursor) {
              cursor.setTime(new Date(event.createdAt).getTime());
            }
          }
        } catch (error) {
          this.logger.error('lecture du flux impossible', {
            error: (error as Error).message,
          });
        }
      };

      const timer = setInterval(() => void read(), POLL_INTERVAL_MS);

      subscriber.add(() => {
        closed = true;
        clearInterval(timer);
      });

      // Premiere lecture immediate : le client ne doit pas attendre un
      // intervalle complet pour voir ce qui s'est deja produit.
      void read();
    });
  }

  /** Evenements d'un utilisateur posterieurs a un instant donne. */
  private async eventsSince(userId: string, since: Date): Promise<StreamEvent[]> {
    // ------------------------------------------------------------------------
    // `channel = 'push'` ET NON TOUS LES CANAUX
    // ------------------------------------------------------------------------
    // La table `notification` porte des messages SORTANTS : un e-mail, un
    // SMS, une notification push. Sans ce filtre, le flux pushes dans
    // l'application l'information « votre e-mail a ete envoye » — ce que
    // l'utilisateur ne demande pas et ne comprend pas. Le flux doit ne
    // contenir que les evenements destines a l'application.
    //
    // Cette colonne est donc un filtre de SENS, pas une commodite :
    // c'est ce qui distingue une notification in-app d'un email envoye.
    const result = await sql<NotificationRow>`
      SELECT id, event, payload, created_at
      FROM notification
      WHERE user_id = ${userId}
        AND channel = 'push'
        AND created_at > ${since}
        AND status IN ('queued', 'sending', 'sent', 'delivered')
      ORDER BY created_at ASC, id ASC
      LIMIT ${BATCH_SIZE}
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      type: row.event,
      createdAt: new Date(row.created_at).toISOString(),
      payload: row.payload ?? {},
    }));
  }
}
