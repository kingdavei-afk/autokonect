import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STATUSES,
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  OCCUPYING_STATUSES,
  TERMINAL_STATUSES,
  TransitionNotAllowedError,
  allowedTransitions,
  allowedTransitionsForActor,
  assertTransition,
  canTransition,
  isBookingStatus,
  isCancellableByClient,
  isTerminal,
  occupiesVehicle,
  wasRefunded,
  type BookingStatus,
} from './state-machine.js';

const ALL = BOOKING_STATUSES;

describe('integrite du graphe', () => {
  it('declare une transition pour chaque etat', () => {
    for (const status of ALL) {
      expect(BOOKING_TRANSITIONS[status], `etat ${status}`).toBeDefined();
    }
  });

  it('ne declare que des etats connus comme destinations', () => {
    for (const from of ALL) {
      for (const to of BOOKING_TRANSITIONS[from]) {
        expect(isBookingStatus(to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('ne redclare aucune transition identique a son etat', () => {
    for (const from of ALL) {
      expect(BOOKING_TRANSITIONS[from]).not.toContain(from);
    }
  });

  it('rend tout etat terminal effectivement sans sortie', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(BOOKING_TRANSITIONS[status], `${status} devrait etre terminal`).toHaveLength(0);
    }
  });

  it('ne rend aucun etat non terminal sans issue', () => {
    // Un etat sans sortie et non terminal est une impasse : la
    // reservation y resterait bloquee pour toujours.
    for (const status of ALL) {
      if (!isTerminal(status)) {
        expect(BOOKING_TRANSITIONS[status].length, `${status} est une impasse`).toBeGreaterThan(0);
      }
    }
  });

  it('rejoint un etat terminal depuis tout etat non terminal', () => {
    // Evite qu'une reservation reste bloquee indefiniment.
    const reachesTerminal = (
      from: BookingStatus,
      seen: Set<BookingStatus> = new Set<BookingStatus>(),
    ): boolean => {
      if (seen.has(from)) return false;
      seen.add(from);

      if (isTerminal(from)) return true;
      return BOOKING_TRANSITIONS[from].some((to) => reachesTerminal(to, seen));
    };

    for (const status of ALL) {
      expect(reachesTerminal(status), `${status} n'atteint jamais un etat terminal`).toBe(true);
    }
  });
});

describe('coherence avec la base de donnees', () => {
  it('les etats occupants correspondent a l index partiel SQL', () => {
    // La migration declare exactement ces etats dans
    // `booking_occupancy_idx`. Toute divergence ferait autoriser ou
    // refuser a tort une reservation.
    const inSql = [
      'awaiting_payment',
      'paid',
      'in_progress',
      'late_return',
      'disputed',
    ] as const;

    expect([...OCCUPYING_STATUSES].sort()).toEqual([...inSql].sort());
  });

  it('tout etat occupant est un etat actif', () => {
    for (const status of OCCUPYING_STATUSES) {
      expect(ACTIVE_STATUSES as readonly string[]).toContain(status);
    }
  });

  it('aucun etat occupant n est terminal', () => {
    // Une reservation terminale qui bloquerait le vehicule le
    // condamnerait indefiniment.
    for (const status of OCCUPYING_STATUSES) {
      expect(isTerminal(status), `${status} ne doit pas etre terminal`).toBe(false);
    }
  });
});

describe('transitions', () => {
  it('permet le parcours nominal', () => {
    expect(canTransition('draft', 'awaiting_payment')).toBe(true);
    expect(canTransition('awaiting_payment', 'paid')).toBe(true);
    expect(canTransition('paid', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('completed', 'closed')).toBe(true);
  });

  it('permet le parcours litige', () => {
    expect(canTransition('in_progress', 'disputed')).toBe(true);
    expect(canTransition('disputed', 'resolved_client')).toBe(true);
    expect(canTransition('resolved_client', 'closed')).toBe(true);
  });

  it('permet le parcours defaillance de paiement', () => {
    expect(canTransition('awaiting_payment', 'expired')).toBe(true);
  });

  it('refuse le saut d etat', () => {
    // Le cas le plus dangereux : encaisser sans passer par le paiement.
    expect(canTransition('draft', 'paid')).toBe(false);
    expect(canTransition('draft', 'in_progress')).toBe(false);
    expect(canTransition('awaiting_payment', 'in_progress')).toBe(false);
    expect(canTransition('awaiting_payment', 'completed')).toBe(false);
  });

  it('refuse de ressusciter une reservation annulee', () => {
    expect(canTransition('cancelled_client', 'paid')).toBe(false);
    expect(canTransition('cancelled_provider', 'in_progress')).toBe(false);
    expect(canTransition('expired', 'paid')).toBe(false);
    expect(canTransition('closed', 'disputed')).toBe(false);
  });

  it('refuse une double resolution de litige', () => {
    expect(canTransition('resolved_client', 'resolved_provider')).toBe(false);
    expect(canTransition('resolved_split', 'resolved_client')).toBe(false);
  });

  it('refuse de passer une reservation restituee en litige apres cloture', () => {
    expect(canTransition('closed', 'disputed')).toBe(false);
  });

  it('refuse toute sortie d un etat terminal', () => {
    for (const status of TERMINAL_STATUSES) {
      for (const to of ALL) {
        expect(canTransition(status, to), `${status} -> ${to}`).toBe(false);
      }
    }
  });
});

describe('occupation du vehicule', () => {
  it('occupe le vehicule des la demande de paiement', () => {
    // Sans cela, deux clients pourraient reserver le meme vehicule
    // pendant que le premier n'a pas encore paye.
    expect(occupiesVehicle('awaiting_payment')).toBe(true);
  });

  it('libere le vehicule une fois la reservation annulee', () => {
    expect(occupiesVehicle('cancelled_client')).toBe(false);
    expect(occupiesVehicle('cancelled_provider')).toBe(false);
    expect(occupiesVehicle('expired')).toBe(false);
  });

  it('maintient l occupation pendant un litige', () => {
    // Le vehicule peut encore etre restituendamage : il reste bloque.
    expect(occupiesVehicle('disputed')).toBe(true);
  });

  it('libere le vehicule des la restitution effectuee', () => {
    // `completed` signifie restitution sans reclamation : la voiture
    // est rendue et peut etre relouee le jour meme. Attendre `closed`
    // condamnerait le vehicule pendant toute la fenetre d'avis.
    expect(occupiesVehicle('completed')).toBe(false);
    expect(occupiesVehicle('closed')).toBe(false);
  });
});

describe('remboursement', () => {
  it('marque les etats ayant donne lieu a un remboursement', () => {
    expect(wasRefunded('cancelled_client')).toBe(true);
    expect(wasRefunded('cancelled_provider')).toBe(true);
    expect(wasRefunded('resolved_client')).toBe(true);
  });

  it('ne marque pas une reservation en cours', () => {
    expect(wasRefunded('paid')).toBe(false);
    expect(wasRefunded('in_progress')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('laisse passer une transition autorisee', () => {
    expect(() => assertTransition('draft', 'awaiting_payment')).not.toThrow();
  });

  it('leve une erreur explicite sur une transition interdite', () => {
    expect(() => assertTransition('draft', 'paid')).toThrow(TransitionNotAllowedError);

    try {
      assertTransition('draft', 'paid');
    } catch (error) {
      const typed = error as TransitionNotAllowedError;
      expect(typed.from).toBe('draft');
      expect(typed.to).toBe('paid');
      expect(typed.message).toContain('draft -> paid');
      // Le message doit indiquer la sortie de secours, sinon
      // l'exploitant est bloque sans savoir quoi faire.
      expect(typed.message).toContain('awaiting_payment');
    }
  });

  it('signale explicitement un etat sans sortie', () => {
    try {
      assertTransition('closed', 'paid');
    } catch (error) {
      expect((error as Error).message).toContain('etat terminal');
    }
  });
});

describe('transitions par acteur', () => {
  it('l administrateur et la machine voient toutes les transitions', () => {
    for (const status of ALL) {
      expect(allowedTransitionsForActor(status, 'admin')).toHaveLength(
        allowedTransitions(status).length,
      );
    }
  });

  it('le client ne peut pas clore une reservation', () => {
    expect(allowedTransitionsForActor('completed', 'client')).not.toContain('closed');
  });

  it('le fournisseur ne peut pas imposer un arbitrage favorable au client', () => {
    const forProvider = allowedTransitionsForActor('disputed', 'provider');

    expect(forProvider).not.toContain('resolved_client');
    expect(forProvider).not.toContain('resolved_split');
  });

  it('le client ne peut pas resoudre un litige', () => {
    expect(allowedTransitionsForActor('disputed', 'client')).not.toContain('resolved_provider');
  });

  it('le client peut annuler une reservation payee non encore commencee', () => {
    expect(isCancellableByClient('paid')).toBe(true);
  });

  it('le client ne peut plus annuler une fois le vehicule pris en charge', () => {
    // Rendre la voiture en cours de route est une « restitution
    // anticipée », pas une annulation : cela passe par un autre circuit
    // et ne doit pas beneficier des memes conditions.
    expect(isCancellableByClient('in_progress')).toBe(false);
    // `awaiting_payment` n'est PAS dans ce cas : rien n'y est paye et
    // rien n'y est pris. Voir le test suivant.
    expect(isCancellableByClient('closed')).toBe(false);
  });

  it('le client PEUT annuler une reservation qui n est pas encore payee', () => {
    // Rien n'a ete encaisse, aucune caution n'est retenue — A-04 n'est pas
    // en vigueur. Il n'y a donc ni remboursement ni penalite, et
    // `booking_financial_outcome` ne doit pas etre appele sur cette
    // transition : elle presupposerait un encaissement.
    //
    // Interdire cette annulation signifiait qu'un client qui reservait puis
    // changeait d'avis ne pouvait qu'attendre l'expiration, en laissant le
    // vehicule bloque au calendrier pendant ce temps.
    //
    // La sanction prevue, `expired`, est le sort d'une reservation
    // OUBLIEE. Elle ne convient pas a une reservation REFUSEE : le client
    // a decide, et le systeme ne doit pas le contredire.
    expect(isCancellableByClient('awaiting_payment')).toBe(true);
  });
});