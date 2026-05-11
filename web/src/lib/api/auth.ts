import { request } from './client';
import { saveTokens } from './storage';
import type { Tokens, User } from './types';

export async function register(payload: {
  username: string;
  email: string;
  password: string;
  display_name?: string | null;
}): Promise<Tokens> {
  const tokens = await request<Tokens>('/register', {
    method: 'POST',
    body: payload,
    auth: false,
    endpoint: 'auth'
  });
  saveTokens(tokens);
  return tokens;
}

export async function login(emailOrUsername: string, password: string): Promise<Tokens> {
  const tokens = await request<Tokens>('/login', {
    method: 'POST',
    body: { email_or_username: emailOrUsername, password },
    auth: false,
    endpoint: 'auth'
  });
  saveTokens(tokens);
  return tokens;
}

export async function me(): Promise<User> {
  return request<User>('/me', { endpoint: 'auth' });
}

export async function logout(refreshToken: string): Promise<void> {
  await request<{ detail: string }>('/logout', {
    method: 'POST',
    body: { refresh_token: refreshToken },
    auth: false,
    endpoint: 'auth'
  });
}

export async function uploadAvatar(file: File): Promise<User> {
  const { loadTokens } = await import('./storage');
  const tokens = loadTokens();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/auth/me/avatar', {
    method: 'POST',
    headers: tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {},
    body: form
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? res.statusText);
  }
  return res.json() as Promise<User>;
}

export async function deleteAvatar(): Promise<void> {
  const { loadTokens } = await import('./storage');
  const tokens = loadTokens();
  const res = await fetch('/api/auth/me/avatar', {
    method: 'DELETE',
    headers: tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {}
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? res.statusText);
  }
}
