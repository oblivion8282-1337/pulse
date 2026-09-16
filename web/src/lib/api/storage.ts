/**
 * Token storage abstraction (Security-Audit 2026-09-16):
 *
 * - `access_token` (15 min) bleibt in localStorage — kurzlebig, JS braucht
 *   ihn für jeden Authorization-Header.
 * - `refresh_token` (30 Tage) wird NICHT mehr dauerhaft gespeichert. Er reist
 *   im HttpOnly-`pulse_rt`-Cookie des auth-svc (Rotation setzt ihn bei jedem
 *   /refresh neu). Ein XSS kann ihn damit weder lesen noch exfiltrieren —
 *   es verliert mit dem Schließen der Seite den dauerhaften Zugriff.
 *
 * Migration: Alt-Clients haben noch einen refresh_token in localStorage. Der
 * wird beim nächsten /refresh einmal im Body mitschickt (Server setzt dabei
 * den Cookie) und danach hier gelöscht.
 */

import type { Tokens } from './types';

const ACCESS_KEY = 'dcc.tokens.access';
/** Nur noch Migration — nach dem ersten Cookie-Refresh wird der Schlüssel gelöscht. */
const REFRESH_KEY = 'dcc.tokens.refresh';

export function loadTokens(): Tokens | null {
  if (typeof window === 'undefined') return null;
  const a = window.localStorage.getItem(ACCESS_KEY);
  if (!a) return null;
  const r = window.localStorage.getItem(REFRESH_KEY) ?? '';
  return { access_token: a, refresh_token: r, token_type: 'bearer' };
}

export function saveTokens(t: Tokens): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCESS_KEY, t.access_token);
  if (t.refresh_token) {
    // Noch Body-Modus (Alt-Server oder Migration) — speichern, damit der
    // nächste Refresh wieder funktioniert.
    window.localStorage.setItem(REFRESH_KEY, t.refresh_token);
  } else {
    // Cookie-Modus: nichts Persistes. Ein eventuell noch vorhandener Alt-
    // Token wird jetzt entwertet — der Cookie hat ihn ersetzt.
    window.localStorage.removeItem(REFRESH_KEY);
  }
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
