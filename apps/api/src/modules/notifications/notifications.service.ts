import { Inject, Injectable } from '@nestjs/common';
import { sql, type Db } from '@adkcars/database';

import { DATABASE } from '../../common/tokens';

/** Canaux de notification (CDCS 6.7). */
export type NotificationChannel = 'email' | 'sms' | 'push' | 'whatsapp';

export type NotificationEvent =
  | 'vehicle.submitted'
  | 'vehicle.approved'
  | 'vehicle.rejected'
  | 'vehicle.document_rejected'
  | 'vehicle.published';

export interface QueueNotificationInput {
  userId: string | null;
  event: NotificationEvent;
  channel: NotificationChannel;
  subject?: string | null;
  body: string;
  payload?: Record<string, unknown>;
  /** 1 = plus urgent. Les e-mails et SMS critiques utilisent 1 ou 2. */
  priority?: number;
}

/**
 * File de notifications.
 *
 * Ce service n'ENVOIE rien : il ecrit dans la table `notification`, et un
 * worker (phase P2) drains la file. Cette separation est volontaire
 * (CDCS 14.5) — une notification ne doit jamais faire echouer
 * l'operation metier qui l'a declenchee. Si l'envoi de SMS tombe en
 * panne, la validation administrative reste enregistree.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async queue(input: QueueNotificationInput): Promise<void> {
    if (!input.userId) return;

    await sql`
      INSERT INTO notification
        (user_id, event, channel, priority, status, subject, body, payload)
      VALUES (
        ${input.userId},
        ${input.event},
        ${input.channel},
        ${input.priority ?? 5},
        'queued',
        ${input.subject ?? null},
        ${input.body},
        ${JSON.stringify(input.payload ?? {})}::jsonb
      )
    `.execute(this.db);
  }

  /**
   * Notification critique d'un evenement metier.
   *
   * Le SMS est prioritaire : le canal de secours compte quand le push
   * echoue sur un reseau 3G (CDCS 14.5).
   */
  async queueCritical(
    userId: string | null,
    event: NotificationEvent,
    body: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.queue({
      userId,
      event,
      channel: 'sms',
      body,
      payload,
      priority: 1,
    });

    await this.queue({
      userId,
      event,
      channel: 'email',
      subject: event,
      body,
      payload,
      priority: 3,
    });
  }
}