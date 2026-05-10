/**
 * Token storage abstraction. For Etappe 1 we keep both tokens in
 * localStorage; later Tauri builds will swap this for the Tauri Store
 * plugin via the platform/runtime module.
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
