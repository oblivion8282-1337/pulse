/**
 * Typed fetch wrapper. Handles bearer-auth + transparent JWT refresh.
 *
 * Failed refresh kicks the user out via `clearTokens()` — callers can then
 * route back to /login.
 */

import { clearTokens, isAccessExpired, loadTokens, saveTokens } from './storage';
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

export type ApiEndpoint = 'auth' | 'chat' | 'voice';

export const AUTH_BASE = '/api/auth';
export const CHAT_BASE = '/api/chat';
export const VOICE_BASE = '/api/voice';

function base(endpoint: ApiEndpoint): string {
  if (endpoint === 'auth') return AUTH_BASE;
  if (endpoint === 'voice') return VOICE_BASE;
  return CHAT_BASE;
}

let _refreshInflight: Promise<Tokens | null> | null = null;
// Once a refresh has actually failed and the user has been signed out, lock
// the door: any further refreshIfNeeded call returns null without making a
// second network round-trip. The flag is cleared automatically when fresh
// tokens are saved again (login / new session).
let _refreshLocked = false;

async function refreshIfNeeded(force = false): Promise<Tokens | null> {
  if (_refreshLocked) return null;
  const tokens = loadTokens();
  if (!tokens) return null;
  if (!force && !isAccessExpired(tokens.access_token)) return tokens;

  if (_refreshInflight) return _refreshInflight;
  _refreshInflight = (async () => {
    try {
      const resp = await fetch(`${AUTH_BASE}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh_token })
      });
      if (!resp.ok) {
        clearTokens();
        _refreshLocked = true;
        return null;
      }
      const data = (await resp.json()) as Tokens;
      saveTokens(data);
      _refreshLocked = false;
      return data;
    } catch {
      clearTokens();
      _refreshLocked = true;
      return null;
    } finally {
      _refreshInflight = null;
    }
  })();
  return _refreshInflight;
}

/** Reset the refresh-lock so a fresh login can re-enable refreshes. Called
 * from the auth store after a successful sign-in. */
export function resetRefreshLock(): void {
  _refreshLocked = false;
}

export type RequestOpts = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  endpoint?: ApiEndpoint;
  signal?: AbortSignal;
};

export async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', body, auth = true, endpoint = 'chat', signal } = opts;
  const url = `${base(endpoint)}${path}`;

  let tokens = loadTokens();
  if (auth) {
    tokens = await refreshIfNeeded();
    if (!tokens) throw new ApiError(401, null, 'not authenticated');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {})
  };
  if (auth && tokens) {
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
  }

  const init: RequestInit = {
    method,
    headers,
    signal
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let resp = await fetch(url, init);

  if (resp.status === 401 && auth) {
    // Force a refresh and retry once.
    tokens = await refreshIfNeeded(true);
    if (!tokens) throw new ApiError(401, null, 'refresh failed');
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
    resp = await fetch(url, { ...init, headers });
  }

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
 * pick the boundary requires *not* setting Content-Type. */
export async function requestForm<T>(
  path: string,
  form: FormData,
  opts: { endpoint?: ApiEndpoint; method?: string } = {},
): Promise<T> {
  const { endpoint = 'chat', method = 'POST' } = opts;
  const url = `${base(endpoint)}${path}`;

  let tokens = await refreshIfNeeded();
  if (!tokens) throw new ApiError(401, null, 'not authenticated');

  const make = (t: Tokens): RequestInit => ({
    method,
    headers: { Authorization: `Bearer ${t.access_token}` },
    body: form,
  });

  let resp = await fetch(url, make(tokens));
  if (resp.status === 401) {
    tokens = await refreshIfNeeded(true);
    if (!tokens) throw new ApiError(401, null, 'refresh failed');
    resp = await fetch(url, make(tokens));
  }
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  const data = text ? safeParse(text) : null;
  if (!resp.ok) throw new ApiError(resp.status, data, extractDetail(data) ?? resp.statusText);
  return data as T;
}
