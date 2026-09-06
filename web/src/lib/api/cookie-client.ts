/**
 * Geteilter Cookie-Auth-Fetch-Helfer für auth-svc-Endpoints, die per
 * `pulse_session`-Cookie (HttpOnly) authentifizieren statt per Bearer
 * (credentials, profile, self-host instances).
 *
 * Der Standard-`request()`-Wrapper aus api/client.ts ist Bearer-only, daher
 * direktes `fetch` mit `credentials: 'include'` hier.
 *
 * Renew-Hintergrund: Die Electron-Shell hält den JWT dauerhaft (localStorage,
 * auto-refresh), aber der `pulse_session`-Cookie hat nur 30 Min TTL und wird
 * nur beim Login gesetzt → nach Ablauf/Neustart fehlt er, obwohl der User
 * eingeloggt ist. Bei 401 etabliert `renewSession()` (POST `/session/renew`
 * mit Bearer) einen frischen Cookie und der Request wird einmal wiederholt.
 *
 * Scheitert auch das — weil die JWT-Kette selbst tot ist (revoked/abgelaufen,
 * Tokens von `doRefresh`/`renewSession` bereits gelöscht) — ist die Session
 * endgültig vorbei: `cookieFetch` meldet den User dann über `auth.signOut()`
 * ab. Ohne das bliebe `auth.user` als Zombie-Cache stehen und z. B. die
 * 60-s-Admin-Polls (Anträge/Beschwerden) würden endlos 401 feuern.
 */

import { AUTH_BASE, ApiError, getCloudBearer } from './client';
import { clearTokens, loadTokens } from './storage';
import { safeParse, extractDetail } from './parse';

/**
 * Etabliert den `pulse_session`-Cookie neu aus einem gültigen Login.
 * `/session/renew` akzeptiert den Bearer und setzt einen frischen Cookie.
 * Concurrent-Aufrufe teilen sich einen Inflight.
 */
let _renewInflight: Promise<boolean> | null = null;
export async function renewSession(): Promise<boolean> {
  if (_renewInflight) return _renewInflight;
  _renewInflight = (async () => {
    try {
      const bearer = await getCloudBearer();
      if (!bearer) return false;
      const resp = await fetch(`${AUTH_BASE}/session/renew`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${bearer}` }
      });
      if (resp.status === 401) {
        // Der Server lehnt den frisch geholten Bearer ab (revoked/gesperrt) —
        // dieselbe Konsequenz wie `doRefresh()` bei abgelehntem `/refresh`:
        // Session definitiv tot, Tokens weg + Marker für den Login-Toast.
        // Kein 403-Fall: der (Preemptive-)E-Mail-Gate-Bounce darf hier nicht
        // ausgelöst werden.
        clearTokens();
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('pulse.session_expired', '1');
        }
      }
      return resp.ok;
    } catch {
      return false;
    } finally {
      _renewInflight = null;
    }
  })();
  return _renewInflight;
}

export async function cookieFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
  retried = false
): Promise<T> {
  const { method = 'GET', body } = opts;
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(`${AUTH_BASE}${path}`, init);

  // Fehlender/abgelaufener Session-Cookie → einmal frisch etablieren + retry.
  // Greift sowohl bei Cookie-only-Endpoints ("missing session cookie") als auch
  // bei Bearer-or-Cookie-Endpoints, die ohne Cookie auf "missing bearer token"
  // durchfallen (z.B. /me/profile, /admin/instances).
  if (resp.status === 401 && !retried) {
    if (await renewSession()) return cookieFetch<T>(path, opts, true);
    // Auch der Renew scheitert UND die JWT-Tokens sind weg (entweder hat
    // `doRefresh` sie bei definitiver Ablehnung bereits gelöscht, oder
    // `renewSession` gerade oben) → die Cloud-Session ist endgültig tot.
    // Statt den Zombie-Zustand weiter 401en zu lassen, sauber abmelden.
    // Tokens noch da → transient (z. B. offline während des Renew), der
    // nächste Tick versucht es erneut — die bewusste Gnadenfrist von
    // `doRefresh`/`NetworkError` bleibt unangetastet.
    if (typeof window !== 'undefined' && !loadTokens()) {
      void import('$lib/stores/auth.svelte').then((m) => {
        if (m.auth.user) m.auth.signOut();
      });
    }
  }

  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  const data = text ? safeParse(text) : null;
  if (!resp.ok) throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
  return data as T;
}

// Re-exported (imported above from ./parse) so existing importers
// (complaints.ts, instances.ts) keep working unchanged.
export { safeParse, extractDetail };
