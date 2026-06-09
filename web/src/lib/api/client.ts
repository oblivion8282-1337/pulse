/**
 * Typed fetch wrapper. Handles bearer-auth + transparent JWT refresh.
 *
 * Phase-4.2-Erweiterung: optionaler 3. Parameter `{serverId}` routed das
 * Request an einen Self-Host-Server statt der Cloud. Backwards-Compat:
 * ohne `serverId` läuft alles über `activeServer.current` (Default = Cloud).
 *
 * Auth-Token-Auswahl:
 *  - Cloud (`isCloud: true`) → JWT aus `dcc.tokens.access` (mit Refresh).
 *  - Self-Host (`isCloud: false`) → Bearer aus `sessionTokens.get(id).token`
 *    (kein JWT-Refresh — Cert-Re-Auth-Hook via `setSelfHostReauthHandler`).
 *
 * Nur eine *definitive* Auth-Ablehnung (401/403 von `/refresh`) wirft den User
 * via `clearTokens()` raus. *Transiente* Fehler (offline, 5xx/429 während eines
 * Deploys) werfen `NetworkError`, BEHALTEN die Tokens und überlassen dem
 * Aufrufer den Retry — sonst loggt jeder Deploy-Blip die User aus.
 */

import { clearTokens, isAccessExpired, loadTokens, saveTokens } from './storage';
import { serversStore, CLOUD_HOSTNAME } from './servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { sessionTokens } from './session_tokens.svelte';
import type { ServerEntry } from './servers.svelte';
import type { Tokens } from './types';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Self-Host: Session-Token abgelaufen oder fehlt → Re-Auth nötig. */
export class SessionExpiredError extends Error {
  serverId: string;
  constructor(serverId: string) {
    super(`session expired for server ${serverId}`);
    this.name = 'SessionExpiredError';
    this.serverId = serverId;
  }
}

/**
 * Transienter Fehler beim Reden mit auth-svc (offline, Timeout, 5xx/429
 * während eines rollenden Deploys). Die Session ist NICHT tot — die Tokens
 * werden bewusst BEHALTEN, damit der Aufrufer erneut versuchen kann, statt den
 * User auszuloggen. Abgrenzung zu `ApiError(401/403)`: das heißt, der Server
 * hat die Credentials/den Refresh-Token wirklich abgelehnt → Session tot.
 *
 * Hintergrund: Beim Container-Neustart (watchtower) liefert der Proxy für ein
 * paar Sekunden 502/503. Würde man das wie eine Auth-Ablehnung behandeln
 * (clearTokens), müsste sich nach jedem Deploy, der zufällig mit einem
 * Refresh/Reload zusammenfällt, jeder betroffene User neu einloggen.
 */
export class NetworkError extends Error {
  status: number;
  constructor(status = 0, message?: string) {
    super(message ?? `network error${status ? ` (${status})` : ''}`);
    this.name = 'NetworkError';
    this.status = status;
  }
}

/** True, wenn der Fehler bedeutet, dass die Session definitiv nicht mehr
 *  authentifiziert ist und die Tokens gelöscht gehören (Server hat
 *  Refresh/Credentials abgelehnt). Ein transienter/Offline-Fehler ist NICHT
 *  definitiv — siehe `NetworkError`. */
export function isDefinitiveAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

export type ApiEndpoint = 'auth' | 'chat' | 'voice';

export const AUTH_BASE = '/api/auth';
export const CHAT_BASE = '/api/chat';
export const VOICE_BASE = '/api/voice';

function endpointPath(endpoint: ApiEndpoint): string {
  if (endpoint === 'auth') return AUTH_BASE;
  if (endpoint === 'voice') return VOICE_BASE;
  return CHAT_BASE;
}

/** Resolved den ServerEntry für ein Request (oder undefined → Cloud-Default).
 *  `forceCloud=true` ignoriert activeServer und gibt immer den Cloud-Entry
 *  zurück — wird für die Identity-Plane-Endpoints genutzt. */
function resolveServer(serverId?: string, forceCloud = false): ServerEntry | undefined {
  if (forceCloud) return serversStore.servers.find((s) => s.isCloud);
  if (serverId) return serversStore.find(serverId);
  return activeServer.current;
}

/** Cloud nutzt `/api/{auth,chat,voice}` (nginx-Proxy auf window.location).
 *  Self-Host pre-pendet den vollen Hostname.
 *
 *  Ausnahme: `endpoint === 'auth'` ist immer Cloud-relativ — die Identity-
 *  Plane (Register / Login / Cert-Issue / Profile-Statement / Backups /
 *  WebAuthn / TOTP) lebt ausschließlich in der Pulse-Cloud. Self-Hosts
 *  haben keinen Username/Passwort-Login (Cert-Login statt dessen) und auch
 *  keinen unabhängigen Cert-Issuer. Würden wir hier den activeServer
 *  durchreichen, würde z.B. eine /login-Anfrage nach Server-Switch zum
 *  Self-Host laufen und mit 'invalid credentials' fehlschlagen — der User
 *  käme nicht mehr in seinen Account. */
function buildUrl(server: ServerEntry | undefined, endpoint: ApiEndpoint, path: string): string {
  const ep = endpointPath(endpoint);
  if (endpoint === 'auth' || !server || server.isCloud) {
    return `${ep}${path}`;
  }
  return `${server.hostname}${ep}${path}`;
}

/** Re-Auth-Hook für Self-Host (Phase 4.3 setzt den Cert-Auth-Flow). */
let _selfHostReauth: ((serverId: string) => void) | null = null;
export function setSelfHostReauthHandler(fn: ((serverId: string) => void) | null): void {
  _selfHostReauth = fn;
}

/** Optionale awaitable Variante des Re-Auth-Hooks: erlaubt request() bei
 *  einem 401 zu warten und denselben Request mit frischem Token zu
 *  retrien. Wenn nicht gesetzt → Fallback auf Fire-and-forget + throw. */
let _selfHostReauthAsync: ((serverId: string) => Promise<boolean>) | null = null;
export function setSelfHostReauthAsyncHandler(
  fn: ((serverId: string) => Promise<boolean>) | null,
): void {
  _selfHostReauthAsync = fn;
}

/** Gemeinsamer Helfer: Server + URL + isSelfHost aus Endpoint + Pfad + Route. */
function resolveRoute(
  endpoint: ApiEndpoint,
  path: string,
  route: RequestRoute,
): { server: ServerEntry | undefined; url: string; isSelfHost: boolean } {
  const resolved = resolveServer(route.serverId);
  const server = endpoint === 'auth' ? resolveServer(undefined, true) : resolved;
  const url = buildUrl(server, endpoint, path);
  const isSelfHost = !!server && !server.isCloud;
  return { server, url, isSelfHost };
}

let _refreshInflight: Promise<Tokens | null> | null = null;
let _refreshLocked = false;

async function refreshIfNeeded(force = false): Promise<Tokens | null> {
  if (_refreshLocked) return null;
  const tokens = loadTokens();
  if (!tokens) return null;
  if (!force && !isAccessExpired(tokens.access_token)) return tokens;

  if (_refreshInflight) return _refreshInflight;
  _refreshInflight = (async () => {
    try {
      // Cross-window mutex über die Web-Locks-API — verhindert dass Popups
      // (`watchPartyDetach`/`stream/detach`) parallel zum Hauptfenster
      // `/refresh` feuern und damit Token-Reuse → Familie-Revoke triggern.
      const body = (): Promise<Tokens | null> => doRefresh(tokens.refresh_token);
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('pulse:refresh', body);
      }
      return await body();
    } finally {
      _refreshInflight = null;
    }
  })();
  return _refreshInflight;
}

async function doRefresh(intendedRefreshToken: string): Promise<Tokens | null> {
  const fresh = loadTokens();
  if (!fresh) return null;
  if (fresh.refresh_token !== intendedRefreshToken) return fresh;
  let resp: Response;
  try {
    resp = await fetch(`${AUTH_BASE}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: fresh.refresh_token }),
    });
  } catch {
    // auth-svc gar nicht erreichbar (offline, DNS, oder mitten im Deploy ohne
    // Upstream am Proxy). Transient — Tokens NICHT löschen, sonst loggt ein
    // kurzer Deploy-Blip jeden User aus. Aufrufer soll retrien; Session bleibt.
    throw new NetworkError(0, 'refresh request failed (network)');
  }
  if (resp.ok) {
    const data = (await resp.json()) as Tokens;
    saveTokens(data);
    _refreshLocked = false;
    return data;
  }
  // Server erreicht, aber abgelehnt. Nur eine echte Auth-Ablehnung (Refresh-
  // Token ungültig / revoked / Family-Reuse) killt die Session. 5xx/429/408
  // sind transient (Service-Neustart im Deploy) → Tokens behalten, retrien.
  if (resp.status === 401 || resp.status === 403) {
    clearTokens();
    _refreshLocked = true;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('pulse.session_expired', '1');
    }
    return null;
  }
  throw new NetworkError(resp.status, `refresh failed transiently (${resp.status})`);
}

export function resetRefreshLock(): void {
  _refreshLocked = false;
}

export async function forceTokenRefresh(): Promise<boolean> {
  try {
    return (await refreshIfNeeded(true)) !== null;
  } catch {
    // NetworkError = transient. Konnte jetzt nicht refreshen, aber die Session
    // ist nicht tot — Fehlschlag melden ohne zu werfen; Aufrufer retried später.
    return false;
  }
}

/** Frischer Cloud-Bearer (mit Refresh) für Identity-Plane-Aufrufe, die sonst
 *  Cookie-Auth nutzen (credentials.ts) — nötig, um den `pulse_session`-Cookie
 *  bei Bedarf neu zu etablieren. `null`, wenn nicht (mehr) eingeloggt. */
export async function getCloudBearer(force = false): Promise<string | null> {
  try {
    const t = await refreshIfNeeded(force);
    return t?.access_token ?? null;
  } catch {
    // Transient (NetworkError) — kein Bearer jetzt, aber Session intakt.
    return null;
  }
}

/** Holt den Bearer-Token für einen Request — Cloud=JWT (mit Refresh), Self-Host=Session. */
async function bearerFor(server: ServerEntry | undefined, force = false): Promise<string | null> {
  if (!server || server.isCloud) {
    const t = await refreshIfNeeded(force);
    return t?.access_token ?? null;
  }
  const entry = sessionTokens.get(server.id);
  if (!entry || Date.now() >= entry.expiresAt) {
    if (_selfHostReauth) _selfHostReauth(server.id);
    return null;
  }
  return entry.token;
}

export type RequestOpts = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  endpoint?: ApiEndpoint;
  signal?: AbortSignal;
};

/** Phase 4.2: optionaler 3. Parameter routed das Request an einen anderen Server. */
export type RequestRoute = { serverId?: string };

/** Holt einen Bearer für den Server. Hat ein Self-Host **keinen** gültigen
 *  Session-Token (abgelaufen ODER beim Tab-Reload verloren — der Store ist
 *  in-memory), wird **proaktiv re-authentifiziert** (passwortloser Cert-Login)
 *  und erneut aufgelöst, statt sofort SessionExpiredError zu werfen (F18).
 *  Gibt null zurück, wenn kein Token zu holen ist (z.B. Reauth nicht möglich). */
async function bearerWithReauth(
  server: ServerEntry | undefined,
  isSelfHost: boolean,
): Promise<string | null> {
  let bearer = await bearerFor(server);
  if (!bearer && isSelfHost && server && _selfHostReauthAsync) {
    const ok = await _selfHostReauthAsync(server.id);
    if (ok) bearer = await bearerFor(server);
  }
  return bearer;
}

export async function request<T>(
  path: string,
  opts: RequestOpts = {},
  route: RequestRoute = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, endpoint = 'chat', signal } = opts;
  // Identity-Plane ist immer Cloud-only — selbst wenn der activeServer
  // auf einen Self-Host zeigt, muss /register/login/me/credentials/…
  // gegen die Cloud laufen (s. buildUrl-Kommentar).
  const { server, url, isSelfHost } = resolveRoute(endpoint, path, route);

  let bearer: string | null = null;
  if (auth) {
    bearer = await bearerWithReauth(server, isSelfHost);
    if (!bearer) {
      if (isSelfHost) throw new SessionExpiredError(server!.id);
      throw new ApiError(401, null, 'not authenticated');
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (auth && bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const init: RequestInit = { method, headers, signal };
  if (body !== undefined) init.body = JSON.stringify(body);
  // CORS für Cross-Origin (Cloud-Origin → Self-Host-Origin):
  // explizit `cors`-Mode + Cookies mitschicken falls Self-Host das nutzt.
  if (isSelfHost) { init.mode = 'cors'; init.credentials = 'omit'; }

  let resp = await fetch(url, init);

  if (resp.status === 401 && auth) {
    // Cloud → Token-Refresh + Retry. Self-Host → Re-Auth (await wenn der
    // awaitable Handler registriert ist), dann **denselben Request** mit
    // frischem Token retrien. Ohne Retry müsste der User jeden 401-
    // betroffenen Aufruf manuell wiederholen (z.B. den Submit-Button
    // zweimal drücken), während Re-Auth zwischen den Klicks läuft.
    if (isSelfHost) {
      if (_selfHostReauthAsync) {
        const ok = await _selfHostReauthAsync(server!.id);
        if (ok) {
          const freshBearer = await bearerFor(server);
          if (freshBearer) {
            headers['Authorization'] = `Bearer ${freshBearer}`;
            resp = await fetch(url, { ...init, headers });
          } else {
            throw new SessionExpiredError(server!.id);
          }
        } else {
          throw new SessionExpiredError(server!.id);
        }
      } else {
        if (_selfHostReauth) _selfHostReauth(server!.id);
        throw new SessionExpiredError(server!.id);
      }
    } else {
      const refreshed = await refreshIfNeeded(true);
      if (!refreshed) throw new ApiError(401, null, 'refresh failed');
      headers['Authorization'] = `Bearer ${refreshed.access_token}`;
      resp = await fetch(url, { ...init, headers });
    }
  }

  return parseResponse<T>(resp);
}

async function parseResponse<T>(resp: Response): Promise<T> {
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  const data = text ? safeParse(text) : null;
  if (!resp.ok) throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractDetail(data: unknown): string | null {
  if (data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return null;
}

export function currentAccessToken(): string | null {
  return loadTokens()?.access_token ?? null;
}

/** Same auth + refresh + 401-retry handling as `request`, but for
 * multipart/form-data uploads (avatar, guild icon, etc.). Letting the browser
 * pick the boundary requires *not* setting Content-Type.
 *
 * Phase 4.2: nimmt ebenfalls einen optionalen `serverId`-Route-Parameter. */
export async function requestForm<T>(
  path: string,
  form: FormData,
  opts: { endpoint?: ApiEndpoint; method?: string } = {},
  route: RequestRoute = {},
): Promise<T> {
  const { endpoint = 'chat', method = 'POST' } = opts;
  // Symmetrisch zu request(): Identity-Plane-Endpoints (auth) gehen immer
  // gegen die Cloud, egal welcher Server gerade aktiv ist.
  const { server, url, isSelfHost } = resolveRoute(endpoint, path, route);

  let bearer = await bearerWithReauth(server, isSelfHost);
  if (!bearer) {
    if (isSelfHost) throw new SessionExpiredError(server!.id);
    throw new ApiError(401, null, 'not authenticated');
  }

  const make = (token: string): RequestInit => {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    };
    if (isSelfHost) { init.mode = 'cors'; init.credentials = 'omit'; }
    return init;
  };

  let resp = await fetch(url, make(bearer));
  if (resp.status === 401) {
    if (isSelfHost) {
      if (_selfHostReauth) _selfHostReauth(server!.id);
      throw new SessionExpiredError(server!.id);
    }
    const refreshed = await refreshIfNeeded(true);
    if (!refreshed) throw new ApiError(401, null, 'refresh failed');
    bearer = refreshed.access_token;
    resp = await fetch(url, make(bearer));
  }
  return parseResponse<T>(resp);
}
