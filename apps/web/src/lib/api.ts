import { cookies } from 'next/headers';

/**
 * Client de l'API, execute cote SERVEUR uniquement.
 *
 * ------------------------------------------------------------------------
 * POURQUOI PAS UN CLIENT NAVIGATEUR
 * ------------------------------------------------------------------------
 * L'API porte une authentification par jeton court avec rotation. Si ce
 * jeton vivait dans le navigateur :
 *
 *   * il serait lisible par n'importe quel script de la page, donc
 *     vole par une injection ;
 *   * il devrait etre rafraiche par le client, donc duplique dans le
 *     code client a chaque ecran ;
 *   * il imposerait d'ouvrir le CORS de l'API vers le navigateur.
 *
 * La session est donc un cookie `httpOnly` pose par le serveur, et le
 * serveur seul appelle l'API. Le navigateur ne voit jamais de jeton.
 *
 * ------------------------------------------------------------------------
 * UNE SEULE FONCTION POUR TOUTES LES APPELS
 * ------------------------------------------------------------------------
 * Le jeton d'acces expire en 15 minutes. Chaque appel doit donc etre
 * capable de le rafraicher et de reessayer UNE fois. Dupliquer cette
 * logique dans chaque ecran est exactement la facon de produire une
 * connexion « collee » au bout de quinze minutes.
 */

const ACCESS_COOKIE = 'adkcars_access';
const REFRESH_COOKIE = 'adkcars_refresh';

/** Durees de vie des cookies, alignees sur la configuration de l'API. */
const ACCESS_MAX_AGE = 60 * 15;
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

/** Erreur portant le statut de l'API, pour que l'appelant puisse agir. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function apiUrl(): string {
  const base = process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:3000';
  return base.replace(/\/$/, '');
}

export interface Session {
  accessToken: string;
  refreshToken: string;
}

/**
 * Le cookie doit-il etre marque `secure` ?
 *
 * ------------------------------------------------------------------------
 * NE PAS SE BASER SUR `NODE_ENV`
 * ------------------------------------------------------------------------
 * En developpement local, `next start` fixe `NODE_ENV=production` — la
 * distinction build/ developpement ne dit rien du protocole utilise.
 *
 * Marquer le cookie `secure` sur une connexion HTTP fait que le
 * navigateur le SUPPRIME SILENCIEUSEMENT : la connexion parait
 * reussir, et l'utilisateur est deconnexion a chaque navigation. Le
 * symptome — « je me connecte et je suis deconnecté » — ne renvoie a
 * rien d'utile.
 *
 * La regle est donc le protocole REEL de la requete : HTTPS en
 * production chez Vercel, HTTP en local.
 */
function doitEtreSecure(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0]?.trim() === 'https';

  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}/** Pose les cookies de session. Appele uniquement par le gestionnaire de connexion. */
export async function writeSession(session: Session, request: Request): Promise<void> {
  const jar = await cookies();

  const options = {
    httpOnly: true,
    secure: doitEtreSecure(request),
    sameSite: 'lax' as const,
    path: '/',
  };

  jar.set(ACCESS_COOKIE, session.accessToken, { ...options, maxAge: ACCESS_MAX_AGE });
  jar.set(REFRESH_COOKIE, session.refreshToken, { ...options, maxAge: REFRESH_MAX_AGE });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function readSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(ACCESS_COOKIE)?.value;
  const refreshToken = jar.get(REFRESH_COOKIE)?.value;

  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}

/**
 * Rafraichit la session.
 *
 * ⚠️ L'API detecte la REUTILISATION d'un jeton de rafraîchissement et
 * revoque toute la serie de sessions. Un double appel — deux onglets
 * ouverts, deux requetes simultanees — reutiliserait le meme jeton et
 * deconnecterait l'utilisateur alors qu'il est legitime.
 *
 * Le rafraichissement est donc serialise par une promesse partagee :
 * le second appel attend le resultat du premier au lieu d'en lancer
 * un autre.
 *
 * ⚠️ Le protocole est transmis tel quel : `writeSession` en a besoin
 * pour decider si le cookie doit etre `secure`. Un rafraichissement
 * declenche par `fetch` cote serveur n'a pas de protocole de requete ;
 * on conserve alors le protocole courant.
 */
let refreshInFlight: Promise<Session | null> | null = null;
let protocoleCourant = 'http:';

export function definirProtocole(url: string): void {
  try {
    protocoleCourant = new URL(url).protocol;
  } catch {
    // URL invalide : on garde le protocole par defaut.
  }
}

async function refreshSession(): Promise<Session | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const current = await readSession();
    if (!current) return null;

    try {
      const response = await fetch(`${apiUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        cache: 'no-store',
      });

      if (!response.ok) {
        // Un jeton invalide signifie une session volee ou revoquee :
        // dans les deux cas, la session locale doit disparaitre.
        await clearSession();
        return null;
      }

      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };

      const session: Session = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
      };

      await writeSession(session, new Request(`${protocoleCourant}//session`));
      return session;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Refuse l appel si aucune session n existe. */
  requireAuth?: boolean;
  /** N essaye PAS de rafraichir. Utile pour la deconnexion. */
  noRefresh?: boolean;
}

/**
 * Appelle l'API et traduit son erreur en `ApiError`.
 *
 * Le corps d'erreur de l'API porte `code` et parfois `details` : les
 * deux sont conserves, car un message seul ne permet pas a l'interface
 * d'agir correctement (par exemple proposer les transitions possibles).
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, requireAuth = true, noRefresh = false } = options;

  const send = async (session: Session | null): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (body !== undefined) headers['content-type'] = 'application/json';
    if (session) headers['authorization'] = `Bearer ${session.accessToken}`;

    return fetch(`${apiUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  };

  let session = requireAuth ? await readSession() : null;
  let response = await send(session);

  // Un seul essai de rafraichissement : au-dela, ce serait une session
  // invalide, et boucle ne ferait qu'aggraver la situation.
  if (response.status === 401 && requireAuth && !noRefresh) {
    session = await refreshSession();
    if (session) response = await send(session);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as {
      code?: string;
      message?: string;
      details?: unknown;
    };

    throw new ApiError(
      response.status,
      record.code ?? 'ERREUR',
      record.message ?? `Erreur ${response.status}`,
      record.details,
    );
  }

  return payload as T;
}

/** Session courante, ou `null`. A utiliser pour conditionner le rendu. */
export async function currentUser(): Promise<{
  id: string;
  roles: string[];
  email: string | null;
  phone: string | null;
} | null> {
  const session = await readSession();
  if (!session) return null;

  try {
    return await api('/auth/me');
  } catch {
    return null;
  }
}

export { ACCESS_COOKIE, REFRESH_COOKIE };
