import { describe, expect, it, vi } from 'vitest';

import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Tests du stockage partage du limiteur de debit.
 *
 * Le contrat verifie ici est celui qui pese : un compteur partage doit
 * incremented meme quand plusieurs instances frappent en meme temps, et
 * le blocage doit etre pose des le PREMIER depassement, pas au suivant.
 */

/** Reponses du script Lua, dans l'ordre des valeurs retournees. */
type ScriptReply = [hits: string, ttl: string, blocked: string, blockTtl: string];

function makeStorage(replies: ScriptReply[] | ((body: unknown) => ScriptReply)) {
  const calls: unknown[][] = [];

  const logger = { error: vi.fn() };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as unknown[];
      calls.push(parsed);

      const next = typeof replies === 'function' ? replies(parsed) : replies.shift()!;

      return {
        ok: true,
        json: async () => ({ result: next.map((value) => ({ result: value })) }),
      } as unknown as Response;
    }),
  );

  return {
    storage: new RedisThrottlerStorage('https://redis.test', 'token', logger),
    calls,
    logger,
  };
}

describe('RedisThrottlerStorage', () => {
  describe('configuration', () => {
    it('reconnait une configuration complete', () => {
      expect(
        RedisThrottlerStorage.isConfigured({
          UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
          UPSTASH_REDIS_REST_TOKEN: 't',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });

    it('refuse une configuration partielle', () => {
      // Une seule des deux variables ne permet aucune connexion : la
      // reconnaitre comme configuree masquerait le probleme jusqu'a la
      // premiere requete.
      expect(
        RedisThrottlerStorage.isConfigured({
          UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        } as NodeJS.ProcessEnv),
      ).toBe(false);

      expect(
        RedisThrottlerStorage.isConfigured({
          UPSTASH_REDIS_REST_TOKEN: 't',
        } as NodeJS.ProcessEnv),
      ).toBe(false);

      expect(RedisThrottlerStorage.isConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    });
  });

  describe('comptage', () => {
    it('renvoie le total d appels et le temps restant', async () => {
      const { storage } = makeStorage([['1', '60000', '0', '0']]);

      const record = await storage.increment('cle', 60_000, 5, 0, 'short');

      expect(record).toEqual({
        totalHits: 1,
        timeToExpire: 60_000,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('laisse passer tant que la limite n est pas atteinte', async () => {
      const { storage } = makeStorage([['5', '60000', '0', '0']]);

      const record = await storage.increment('cle', 60_000, 5, 0, 'short');

      // Cinquieme appel pour une limite de cinq : autorisé.
      expect(record.isBlocked).toBe(false);
    });

    it('bloque des le premier depassement', async () => {
      const { storage } = makeStorage([['6', '59000', '1', '30000']]);

      const record = await storage.increment('cle', 60_000, 5, 30_000, 'short');

      // Sixieme appel : bloque, et la duree de blocage est transmise
      // pour que le client sache quand reessayer.
      expect(record.isBlocked).toBe(true);
      expect(record.totalHits).toBe(6);
      expect(record.timeToBlockExpire).toBe(30_000);
    });

    it('conserve le blocage deja pose meme apres un compteur decreu', async () => {
      // Cas reel : la fenetre du compteur expire, le blocage non. Le
      // client doit rester bloque, sinon le blocage ne servirait a rien.
      const { storage } = makeStorage([['1', '60000', '1', '12000']]);

      const record = await storage.increment('cle', 60_000, 5, 30_000, 'short');

      expect(record.isBlocked).toBe(true);
      expect(record.timeToBlockExpire).toBe(12_000);
    });

    it('ne bloque pas si aucune duree de blocage n est configuree', async () => {
      const { storage } = makeStorage([['99', '60000', '0', '0']]);

      const record = await storage.increment('cle', 60_000, 5, 0, 'short');

      expect(record.isBlocked).toBe(false);
    });
  });

  describe('atomicite', () => {
    it('evalue le script en UNE seule requete', async () => {
      // Le point central de la conception. Avec une suite INCR puis
      // PTTL puis SET, deux requetes concurrentes peuvent toutes deux
      // lire un compteur sous la limite et ne jamais poser le blocage.
      // Un seul aller-retour Rend la section critique indivisible.
      const { storage, calls } = makeStorage([['1', '60000', '0', '0']]);

      await storage.increment('cle', 60_000, 5, 30_000, 'short');

      expect(calls).toHaveLength(1);

      const body = calls[0] as unknown[];
      expect(body[0]).toContain('INCR');
      expect(body[0]).toContain('PTTL');
      // Le blocage est pose dans le meme script, pas par un second appel.
      expect(body[0]).toContain("redis.call('SET', KEYS[2]");
    });

    it('passe les compteurs et les durees en arguments, jamais concatenes', async () => {
      // Un script concatene ouvrirait une injection : la cle vient de la
      // requete HTTP et peut contenir des caracteres arbitraires.
      const { storage, calls } = makeStorage([['1', '60000', '0', '0']]);

      await storage.increment("cle'; DROP TABLE users; --", 60_000, 5, 0, 'short');

      const body = calls[0] as unknown[];

      // Le script est un element distinct, la cle un argument suivant.
      expect(body[0]).not.toContain('DROP TABLE');
      expect(body).toContain("throttle:short:cle'; DROP TABLE users; --");
    });
  });

  describe('nommage des cles', () => {
    it('isole les compteurs par lot de limites', async () => {
      const { storage, calls } = makeStorage([['1', '60000', '0', '0']]);

      await storage.increment('cle', 60_000, 5, 0, 'short');

      // Sans cet prefixe, la limite courte et la limite moyenne
      // partageraient le meme compteur, et la courte contaminerait la
      // moyenne : un attaquant s'epuiserait sur la moyenne pour contourner
      // la limite de connexion.
      expect(calls[0]).toContain('throttle:short:cle');
    });

    it('utilise une cle de blocage distincte du compteur', async () => {
      const { storage, calls } = makeStorage([['1', '60000', '0', '0']]);

      await storage.increment('cle', 60_000, 5, 0, 'short');

      const body = calls[0] as unknown[];

      // Ordre envoye a EVAL : [script, nombre de cles, cle 1, cle 2,
      // ttl, limite, duree de blocage].
      expect(body[1]).toBe('2');
      expect(body[2]).toBe('throttle:short:cle');
      expect(body[3]).toBe('throttle:short:cle:blocked');
    });
  });

  describe('panne du stockage partage', () => {
    it('laisse passer la requete et journalise', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('connexion refusee');
        }),
      );

      const logger = { error: vi.fn() };
      const storage = new RedisThrottlerStorage('https://redis.test', 'token', logger);

      const record = await storage.increment('cle', 60_000, 5, 0, 'short');

      // Refuser tout le trafic parce qu'un cache est tombe serait une
      // panne plus grave que l'absence de limitation. La degradation est
      // assumee, mais elle doit etre visible.
      expect(record.isBlocked).toBe(false);
      expect(record.totalHits).toBe(0);
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it('laisse passer aussi sur une reponse HTTP en erreur', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
      );

      const logger = { error: vi.fn() };
      const storage = new RedisThrottlerStorage('https://redis.test', 'token', logger);

      const record = await storage.increment('cle', 60_000, 5, 0, 'short');

      expect(record.isBlocked).toBe(false);
      expect(logger.error).toHaveBeenCalledOnce();
    });
  });
});
