/**
 * Fournisseur de SMS.
 *
 * Interface etablie pour permettre d'injecter un adapteur reel sans
 * toucher au code metier (CDCS 14.1). Chaque operateur dispose de son
 * propre adapteur et de son propre cycle de certification : c'est
 * precisement pourquoi aucun appel direct a une API d'operateur n'est
 * tolere ici.
 */
export interface SmsMessage {
  /** Numero destinataire en E.164. */
  to: string;
  /** Texte du message. */
  body: string;
  /** Reference de correlation, reprise dans le tableau de bord. */
  reference: string;
}

export interface SmsSendResult {
  accepted: boolean;
  /** Reference attribuee par le fournisseur. */
  externalRef?: string;
  error?: string;
  /** Cout unitaire, pour le suivi du budget notification (CDCS 11.8). */
  cost?: number;
}

/** Cle d'injection du fournisseur actif. */
export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * Sous-ensemble dont le module Auth a besoin.
 * Permet au module Auth de ne pas dependre d'une implementation
 * particuliere : brancher Orange Money, MTN ou Wave ne change rien ici.
 */
export interface SmsSender {
  send(message: SmsMessage): Promise<SmsSendResult>;
}