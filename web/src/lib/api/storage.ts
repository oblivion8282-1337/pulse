/**
 * Token storage abstraction. We keep both tokens in localStorage; under the
 * Electron shell this could later be swapped for `window.pulse.store.*` (see
 * `$lib/platform/runtime.ts` / `$lib/stream/persistence.ts`), but localStorage
 * works fine for both the browser and the Electron renderer today.
 *
 * SECURITY TRADEOFF — XSS-stealable credentials: both `access_token` and the
 * longer-lived `refresh_token` live in same-origin-readable localStorage. Any
 * stored/reflected XSS on the origin can exfiltrate both and ride the refresh
 * rotation for indefinite account takeover. Mitigations in place: strict
 * DOMPurify/{@html} hygiene, refresh-token rotation + token-reuse family-revoke
 * + single-flight Web Lock in `client.ts`. The proper fix is to move the
 * refresh token into an HttpOnly + SameSite=Strict cookie issued by auth-svc
 * (the browser-session cookie machinery already exists in
 * `services/auth/.../browser_sessions.py`) and keep only the short-lived access
 * token in JS — but that is a cross-service change (auth-svc /login + /refresh,
 * proxy cookie forwarding, and `client.ts`' doRefresh/loadTokens), not a
 * single-file edit here. See audit findings 108 / 147.
 */

import type { Tokens } from './types';

const ACCESS_KEY = 'dcc.tokens.access';
const REFRESH_KEY = 'dcc.tokens.refresh';

export function loadTokens(): Tokens | null {
  if (typeof window === 'undefined') return null;
  const a = window.localStorage.getItem(ACCESS_KEY);
  const r = window.localStorage.getItem(REFRESH_KEY);
  if (!a || !r) return null;
  return { access_token: a, refresh_token: r, token_type: 'bearer' };
}

export function saveTokens(t: Tokens): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCESS_KEY, t.access_token);
  window.localStorage.setItem(REFRESH_KEY, t.refresh_token);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
}

/**
 * Decode the JWT payload without verifying the signature. Used only to
 * read `exp` for proactive refresh; the server is the source of truth.
 */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function isAccessExpired(token: string, leewaySeconds = 30): boolean {
  const payload = jwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return Math.floor(Date.now() / 1000) + leewaySeconds >= payload.exp;
}
