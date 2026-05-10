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

export type ApiEndpoint = 'auth' | 'chat';

export const AUTH_BASE = '/api/auth';
export const CHAT_BASE = '/api/chat';

function base(endpoint: ApiEndpoint): string {
  return endpoint === 'auth' ? AUTH_BASE : CHAT_BASE;
}

let _refreshInflight: Promise<Tokens | null> | null = null;

async function refreshIfNeeded(force = false): Promise<Tokens | null> {
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
        return null;
      }
      const data = (await resp.json()) as Tokens;
      saveTokens(data);
      return data;
    } catch {
      clearTokens();
      return null;
    } finally {
      _refreshInflight = null;
    }
  })();
  return _refreshInflight;
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
