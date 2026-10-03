/**
 * Stockage partage du limiteur de debit, via Redis compatible REST
 * (Upstash ou equivalent).
 *
 * ------------------------------------------------------------------------
 * POURQUOI CE CHANGEMENT EST INDISPENSABLE
 * ------------------------------------------------------------------------
 * Le stockage par defaut de `@nestjs/throttler` est un `new Map()` en
 * memoire du processus (verifie : `throttler.service.js`). Sur un serveur
 * unique cela va.
 *
 * Sur Vercel, chaque invocation peut atterrir sur une instance neuve : le
 * compteur repart de zero. Concretement, une protection annoncee a
 * « 5 tentatives par minute » devient infinie, et le code OTP a six
 * chiffres devient devinable par repetition. C'est une regression de
 * securite SILENCIEUSE : aucun test ne la detecte, aucune alerte ne se
 * declenche, la protection est simplement absente.
 *
 * Le stockage doit donc etre PARTAGE entre toutes les instances.
 *
 * ------------------------------------------------------------------------
 * CHOIX TECHNIQUE
 * ------------------------------------------------------------------------
 * Appels HTTP plutot que TCP : une connexion TCP persistante vers Redis
 * ne tient pas dans une fonction serverless, dont la duree de vie est
 * celle d'une requete. Upstash expose une API REST, ce qui convient.
 *
 * ------------------------------------------------------------------------
 * ATOMICITE : LE POINT DELICAT
 * ------------------------------------------------------------------------
 * Une premiere version faisait trois allers-retours (INCR, PTTL, SET).
 * C'est FAUX. Entre le INCR et la verification du blocage, une autre
 * requete peut passer : le blocage n'est alors pose que par la derniere
 * des requetes concurrentes, et le compteur a deja depasse la limite.
 * Sur une attaque distribuee, c'est precisement le cas qui compte.
 *
 * Le calcul est donc fait dans un script Lua evalue cote Redis : une
 * seule execution atomique, un seul aller-retour. La cle de blocage et
 * la cle de compteur sont lues et ecrites dans la meme section critique.
 *
 * ------------------------------------------------------------------------
 * COMPORTEMENT EN CAS DE PANNE
 * ------------------------------------------------------------------------
 * Si Redis est injoignable, le service ne BLOQUE PAS les requetes : il
 * laisse passer et journalise. Refuser tout le trafic parce qu'un cache
 * est tombe serait une panne plus grave que l'absence de limitation.
 * La degradation est visible dans les journaux, pas silencieuse.
 */

/**
 * Script Lua : increment, expiration, blocage, dans une seule execution.
 *
 * Convention de retour : tableau de quatre chaines, pour que le client
 * n'ait pas a deviner le type de chaque valeur.
 */
const LIMITER_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])

if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end

local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  -- Cas impossible en theory (INCR vient de poser la cle) mais
  -- defensif : sans expiration, le compteur ne disparait jamais.
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  return { tostring(hits), tostring(ttl), '1', tostring(blockTtl) }
end

local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

if hits > limit and blockDuration > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', blockDuration)
  return { tostring(hits), tostring(ttl), '1', tostring(blockDuration) }
end

return { tostring(hits), tostring(ttl), '0', '0' }
`;

interface UpstashPipelineResponse {
  result?: Array<{ result?: unknown; error?: string | null }>;
  error?: string | null;
}

export class RedisThrottlerStorage {
  static readonly BLOCK_SUFFIX = ':blocked';

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly logger: {
      error(message: string, meta?: unknown): void;
    },
  ) {}

  /** Le stockage partage est-il configure ? */
  static isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env['UPSTASH_REDIS_REST_URL'] && env['UPSTASH_REDIS_REST_TOKEN']);
  }

  /**
   * Compteur partage.
   *
   * @param key          cle generee par le garde (route + utilisateur)
   * @param ttl          duree de vie du compteur, en millisecondes
   * @param limit        nombre d'appels autorises
   * @param blockDuration duree de blocage, en millisecondes
   * @param throttlerName nom du lot de limites (court, moyen)
   */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const counterKey = `throttle:${throttlerName}:${key}`;
    const blockedKey = `${counterKey}${RedisThrottlerStorage.BLOCK_SUFFIX}`;

    try {
      const [hits, timeToExpire, blocked, timeToBlockExpire] = await this.evalScript([
        LIMITER_SCRIPT,
        // Second element du protocole EVAL : le NOMBRE de cles, pas la
        // longueur de la premiere. C'est ce nombre qui dit a Redis ou
        // commence la liste des arguments ; une valeur erronee fait
        // pointer `KEYS[1]` ailleurs, et le blocage porterait sur une
        // cle arbitraire.
        '2',
        counterKey,
        blockedKey,
        String(ttl),
        String(limit),
        String(blockDuration),
      ]);

      return {
        totalHits: Number(hits),
        timeToExpire: Number(timeToExpire),
        isBlocked: blocked === '1',
        timeToBlockExpire: Number(timeToBlockExpire),
      };
    } catch (error) {
      // Degradation assumee : laisser passer plutot que tout bloquer.
      // Journalise, donc visible -- et pas une protection silencieusement
      // inexistante comme le serait une memoroire par instance.
      this.logger.error('limitation de debit indisponible, requete laissee passer', {
        throttler: throttlerName,
        error: (error as Error).message,
      });

      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  /** Execute le script via le point d'entree EVAL generique d'Upstash. */
  private async evalScript(parts: unknown[]): Promise<unknown[]> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
    });

    if (!response.ok) {
      throw new Error(`Redis HTTP ${response.status}`);
    }

    const payload = (await response.json()) as UpstashPipelineResponse;

    if (payload.error) {
      throw new Error(payload.error);
    }

    const result = payload.result;

    if (!Array.isArray(result)) {
      throw new Error('reponse Redis inattendue');
    }

    return result.map((row) => {
      if (row && typeof row === 'object' && 'error' in row && row.error) {
        throw new Error(String(row.error));
      }
      return row && typeof row === 'object' && 'result' in row ? row.result : row;
    });
  }
}
