import { describe, expect, it } from 'vitest';

import {
  assertPaymentTransition,
  canTransitionPayment,
  isPaymentSettled,
  isPaymentStatus,
  isPaymentTerminal,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_SETTLED_STATUSES,
  PAYMENT_STATUSES,
  PAYMENT_TERMINAL_STATUSES,
  PAYMENT_TRANSITIONS,
  PaymentTransitionNotAllowedError,
  REFUND_KINDS,
  REFUND_STATUSES,
  shouldIgnoreRepeatedWebhook,
  type PaymentStatus,
} from './payment-state-machine.js';

/**
 * La machine a etats du paiement.
 *
 * Ces tests verifient le COTE CONTRAT. Le cote base est verifie par
 * `tests/paiement-machine-smoke.sql`, et un declencheur detecte la
 * divergence entre les deux.
 *
 * Aucun test ne peut voir cet ecart : ceux-la ne regardent que ce
 * fichier, ceux-ci ne regardent que la base.
 */

describe('ensemble des etats', () => {
  it('expose les six etats de la contrainte SQL', () => {
    // La liste doit etre identique a `payment_status_check` en base. Une
    // divergence ici produirait un etat que le code croit valide et que
    // la base refuse.
    expect([...PAYMENT_STATUSES]).toEqual([
      'pending',
      'authorized',
      'paid',
      'failed',
      'cancelled',
      'refunded',
    ]);
  });

  it('reconnait un etat connu, et refuse un inconnu', () => {
    expect(isPaymentStatus('paid')).toBe(true);
    expect(isPaymentStatus('cashed')).toBe(false);
    // Une chaine vide n'est pas un etat : l'accepterait ferait passer
    // une valeur vide dans une comparaison.
    expect(isPaymentStatus('')).toBe(false);
  });

  it('aligne les moyens de paiement sur la contrainte SQL', () => {
    expect([...PAYMENT_METHODS]).toEqual(['mobile_money', 'card', 'cash', 'transfer']);
  });

  it('aligne les natures d encaissement sur la contrainte SQL', () => {
    expect([...PAYMENT_KINDS]).toEqual([
      'rental',
      'deposit',
      'penalty',
      'extra_charge',
      'subscription',
    ]);
  });

  it('aligne les statuts et natures de remboursement sur la base', () => {
    expect([...REFUND_STATUSES]).toEqual(['pending', 'succeeded', 'failed']);
    expect([...REFUND_KINDS]).toEqual([
      'refund',
      'deposit_release',
      'deposit_capture',
      'chargeback',
    ]);
  });
});

describe('proprietes structurelles', () => {
  it('n autorise que des transitions vers des etats connus', () => {
    for (const [depuis, vers] of Object.entries(PAYMENT_TRANSITIONS)) {
      expect(isPaymentStatus(depuis)).toBe(true);
      for (const cible of vers) {
        expect(isPaymentStatus(cible)).toBe(true);
      }
    }
  });

  it('couvre tous les etats declares', () => {
    // Un etat absent du tableau de transitions serait inaccessible :
    // `PAYMENT_TRANSITIONS[etat]` renverrait `undefined`, et
    // `canTransitionPayment` leverait au lieu de renvoyer `false`.
    // Le symptome serait un 500 sur une transition refusee.
    for (const statut of PAYMENT_STATUSES) {
      expect(Object.keys(PAYMENT_TRANSITIONS)).toContain(statut);
    }
  });

  it('laisse les etats terminaux sans sortie', () => {
    for (const terminal of PAYMENT_TERMINAL_STATUSES) {
      expect(PAYMENT_TRANSITIONS[terminal]).toHaveLength(0);
      expect(isPaymentTerminal(terminal)).toBe(true);
    }
  });

  it('rend tout etat non terminal accessible depuis pending', () => {
    // Propriete de connexite. Un etat que l'on ne peut pas atteindre
    // depuis `pending` est un etat que le produit ne saura jamais
    // produire — et dont la presence dans l'enumeration ne sert qu'a
    // tromper la lecture.
    const atteignables = new Set<PaymentStatus>(['pending']);
    let progresse = true;

    while (progresse) {
      progresse = false;
      for (const depuis of [...atteignables]) {
        for (const cible of PAYMENT_TRANSITIONS[depuis]) {
          if (!atteignables.has(cible)) {
            atteignables.add(cible);
            progresse = true;
          }
        }
      }
    }

    expect([...atteignables].sort()).toEqual([...PAYMENT_STATUSES].sort());
  });

  it('marque `paid` comme seul etat d argent deplace, hors remboursement', () => {
    expect([...PAYMENT_SETTLED_STATUSES]).toEqual(['paid', 'refunded']);
    expect(isPaymentSettled('paid')).toBe(true);
    expect(isPaymentSettled('refunded')).toBe(true);
    expect(isPaymentSettled('authorized')).toBe(false);
    expect(isPaymentSettled('pending')).toBe(false);
  });
});

describe('transitions interdites', () => {
  it('refuse paid -> pending', () => {
    // LE test central. Sans lui, un webhook retransmis pourrait faire
    // repasser un paiement encaisse en attente, puis le rejouer en
    // `paid` : la commission serait creditee deux fois.
    expect(canTransitionPayment('paid', 'pending')).toBe(false);
  });

  it('refuse paid -> paid', () => {
    // Absente du catalogue : c'est ce qui rend le doublon DETECTABLE.
    // L'inscrire comme transition legitime le rendrait inoffensif, et
    // l'idempotence se perdrait sans bruit.
    expect(canTransitionPayment('paid', 'paid')).toBe(false);
  });

  it('refuse que de l argent encaisse disparaisse', () => {
    // `paid` n'a qu'une sortie, vers le remboursement. Un encaissement
    // qui cesse d'etre encaisse disparaitrait du comptabilise.
    expect(canTransitionPayment('paid', 'failed')).toBe(false);
    expect(canTransitionPayment('paid', 'cancelled')).toBe(false);
    expect(canTransitionPayment('paid', 'authorized')).toBe(false);
    expect(canTransitionPayment('paid', 'pending')).toBe(false);
  });

  it('laisse `refunded` definitivement terminal', () => {
    for (const cible of PAYMENT_STATUSES) {
      expect(canTransitionPayment('refunded', cible)).toBe(false);
    }
  });

  it('laisse `cancelled` definitivement terminal', () => {
    for (const cible of PAYMENT_STATUSES) {
      expect(canTransitionPayment('cancelled', cible)).toBe(false);
    }
  });

  it('n autorise le reessai que depuis `failed`, vers `pending`', () => {
    // `failed -> pending` est la seule sortie d'un echec. Sans elle, un
    // client dont le solde etait insuffisant devrait recreer une
    // reservation, et perdre sa place dans le calendrier.
    expect(canTransitionPayment('failed', 'pending')).toBe(true);
    expect(canTransitionPayment('failed', 'paid')).toBe(false);
    expect(canTransitionPayment('failed', 'authorized')).toBe(false);
  });

  it('n autorise pas de retour en arriere depuis `authorized`', () => {
    expect(canTransitionPayment('authorized', 'pending')).toBe(false);
  });
});

describe('assertPaymentTransition', () => {
  it('laisse passer une transition autorisee, silencieusement', () => {
    expect(() => assertPaymentTransition('pending', 'paid')).not.toThrow();
    expect(() => assertPaymentTransition('failed', 'pending')).not.toThrow();
  });

  it('leve sur une transition interdite, en nommant les issues possibles', () => {
    // Le message doit indiquer la sortie possible : c'est lui qui permet
    // de corriger sans ouvrir la machine a etats.
    expect(() => assertPaymentTransition('paid', 'pending')).toThrow(
      PaymentTransitionNotAllowedError,
    );

    try {
      assertPaymentTransition('paid', 'pending');
      expect.unreachable('aurait du lever');
    } catch (erreur) {
      const echec = erreur as PaymentTransitionNotAllowedError;
      expect(echec.from).toBe('paid');
      expect(echec.to).toBe('pending');
      expect(echec.allowed).toEqual(['refunded']);
      expect(echec.message).toContain('paid -> pending');
      expect(echec.message).toContain('refunded');
    }
  });

  it('distingue un etat terminal d un etat bloque', () => {
    // Un etat terminal n'a AUCUNE sortie ; un etat qui en a n'est pas
    // bloque. Confondre les deux ferait croire a un bug de
    // configuration alors que le comportement est correct.
    try {
      assertPaymentTransition('refunded', 'paid');
      expect.unreachable('aurait du lever');
    } catch (erreur) {
      expect((erreur as Error).message).toContain('terminal');
    }

    try {
      assertPaymentTransition('pending', 'refunded');
      expect.unreachable('aurait du lever');
    } catch (erreur) {
      expect((erreur as Error).message).not.toContain('terminal');
      expect((erreur as Error).message).toContain('authorized');
    }
  });
});

describe('shouldIgnoreRepeatedWebhook', () => {
  it('ignore un doublon sur un paiement encaisse', () => {
    expect(shouldIgnoreRepeatedWebhook('paid')).toBe(true);
    expect(shouldIgnoreRepeatedWebhook('refunded')).toBe(true);
  });

  it('NEUTRALISE PAS un doublon sur un paiement en echec', () => {
    // Le cas delicieux. Un client qui reclique « payer » apres un echec
    // doit pouvoir reussir. Appliquer « un paiement deja termine se
    // ignore » a `failed` confondrait un doublon de paiement et un
    // nouvel essai — et le client ne pourrait plus payer.
    expect(shouldIgnoreRepeatedWebhook('failed')).toBe(false);
    expect(shouldIgnoreRepeatedWebhook('pending')).toBe(false);
    expect(shouldIgnoreRepeatedWebhook('authorized')).toBe(false);
  });

  it('traite un webhook tardif sur un paiement annule', () => {
    // Cas reel : le client annule pendant que la notification est en
    // vol, et le prestataire confirme malgre tout. Le webhook DOIT
    // etre traite — c'est la seule facon de detecter que le client a paye
    // pour un vehicule qu'il n'aura pas.
    //
    // L'ignorer laisserait l'argent bloque sans que personne ne le voie.
    // La base refuse ensuite l'encaissement sur une reservation
    // annulee, ce qui transforme le paiement orphelin en dossier de
    // remboursement a traiter.
    expect(shouldIgnoreRepeatedWebhook('cancelled')).toBe(false);
  });

  it('aligne sa reponse sur les etats ou de l argent a bouge', () => {
    // Les deux fonctions repondent a la MEME question — « l'argent a-t-il
    // deja bouge ? » — donc elles doivent repondre pareil. Si elles
    // divergeaient, l'une des deux laisserait passer un doublon.
    for (const statut of PAYMENT_STATUSES) {
      expect(shouldIgnoreRepeatedWebhook(statut)).toBe(isPaymentSettled(statut));
    }
  });
});
