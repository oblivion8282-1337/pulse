/**
 * Durabler Cloud-Login der Server-App.
 *
 * Die Web-App hält access_token + refresh_token in localStorage und refresht
 * proaktiv (web/src/lib/api/{storage,client}.ts). Die Server-App lädt server.html
 * (file://) statt der Web-App und kann den 30-Min-`pulse_session`-Cookie nach
 * einem App-Neustart nicht neu prägen — sie hatte deshalb KEINEN durablen
 * Cloud-Login (me()/cloudStatus/giveUp brachen nach 30 Min still).
 *
 * Dieses Modul spiegelt das Web-Token-Modell im Main-Prozess:
 *   - Beim Login werden die Tokens aus dem howispulse.com-Fenster übernommen
 *     (main.ts::startLoginWatch liest die localStorage-Keys) und in den
 *     chmod-600-Store gelegt (HOST_AUTH_KEY — renderer-gesperrt wie die Creds).
 *   - `createTokenGetter` liefert einen gültigen Access-Token (Bearer) und
 *     refresht bei Ablauf per POST /api/auth/refresh — Single-Flight (parallele
 *     Aufrufer teilen einen Refresh, sonst triggert Token-Reuse den
 *     Family-Revoke) + sofortiges Persistieren der Rotation.
 *
 * Kein Electron-Import → node:test-tauglich. Loggt nie (Tokens sind Secrets).
 */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface StoreLike {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
}

/** Store-Key der Server-App (renderer-gesperrt, wie pulse.host.creds). */
export const HOST_AUTH_KEY = 'pulse.host.auth';
/** localStorage-Keys der Web-App — Quelle beim Login-Capture (storage.ts). */
export const WEB_ACCESS_KEY = 'dcc.tokens.access';
export const WEB_REFRESH_KEY = 'dcc.tokens.refresh';

export function loadAuth(store: StoreLike): AuthTokens | null {
  const raw = store.get(HOST_AUTH_KEY);
  if (raw == null || typeof raw !== 'object') return null;
  const t = raw as Partial<AuthTokens>;
  if (typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string') return null;
  return { accessToken: t.accessToken, refreshToken: t.refreshToken };
}

export function saveAuth(store: StoreLike, t: AuthTokens): void {
  store.set(HOST_AUTH_KEY, t);
}

export function clearAuth(store: StoreLike): void {
  store.set(HOST_AUTH_KEY, undefined);
}

/** JWT-Payload ohne Signaturprüfung dekodieren — nur um `exp` fürs proaktive
 *  Refresh zu lesen (der Server bleibt die Wahrheit). null bei Unparsebarem. */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Ist der Access-Token abgelaufen (mit Leeway)? Fehlt `exp`, gilt er als
 *  abgelaufen → Refresh wird versucht. */
export function isAccessExpired(token: string, leewaySeconds = 30): boolean {
  const payload = jwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return Math.floor(Date.now() / 1000) + leewaySeconds >= payload.exp;
}

export type RefreshResult = { tokens: AuthTokens } | { tokens: null; dead: boolean };

/** POST /api/auth/refresh — tauscht den (rotierenden) Refresh-Token gegen ein
 *  frisches Token-Paar. `dead: true` bei 401 (Reuse/abgelaufen → Family-Revoke,
 *  Tokens sind tot → Caller löscht), `dead: false` bei Netz-/5xx-Fehler
 *  (transient → Tokens behalten, später erneut versuchen). */
export async function refreshTokens(
  cloudOrigin: string,
  refreshToken: string,
  fetchImpl?: typeof fetch,
): Promise<RefreshResult> {
  const fn = fetchImpl ?? fetch;
  try {
    const resp = await fn(`${cloudOrigin}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (resp.status === 401) return { tokens: null, dead: true };
    if (!resp.ok) return { tokens: null, dead: false };
    const j = (await resp.json()) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string') {
      return { tokens: null, dead: false };
    }
    return { tokens: { accessToken: j.access_token, refreshToken: j.refresh_token } };
  } catch {
    return { tokens: null, dead: false };
  }
}

/** Best-effort serverseitiges Revoke beim Abmelden (POST /api/auth/logout).
 *  Fehler werden verschluckt — der lokale Token wird ohnehin gelöscht. */
export async function revokeRefresh(
  cloudOrigin: string,
  refreshToken: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const fn = fetchImpl ?? fetch;
  try {
    await fn(`${cloudOrigin}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // best effort
  }
}

/** Erzeugt einen Access-Token-Getter über den Store. Liefert einen gültigen
 *  Bearer-Token (refresht bei Ablauf, Single-Flight, persistiert die Rotation)
 *  oder null (keine Tokens / Refresh endgültig fehlgeschlagen). */
export function createTokenGetter(
  store: StoreLike,
  fetchImpl?: typeof fetch,
): (cloudOrigin: string) => Promise<string | null> {
  let inFlight: Promise<string | null> | null = null;

  const refreshOnce = async (cloudOrigin: string, refreshToken: string): Promise<string | null> => {
    const r = await refreshTokens(cloudOrigin, refreshToken, fetchImpl);
    if (r.tokens) {
      saveAuth(store, r.tokens);
      return r.tokens.accessToken;
    }
    if (r.dead) clearAuth(store); // Family-Revoke → Re-Login erzwingen
    return null;
  };

  return async function getAccessToken(cloudOrigin: string): Promise<string | null> {
    const t = loadAuth(store);
    if (!t) return null;
    if (!isAccessExpired(t.accessToken)) return t.accessToken;
    // Single-Flight: parallele Aufrufer teilen denselben Refresh, sonst würde
    // der zweite den schon rotierten Token wiederverwenden → Family-Revoke.
    if (!inFlight) {
      inFlight = refreshOnce(cloudOrigin, t.refreshToken).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
