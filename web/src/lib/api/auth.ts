import { request, requestForm, resetRefreshLock } from './client';
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
  resetRefreshLock();
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
  resetRefreshLock();
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

export function uploadAvatar(file: File): Promise<User> {
  const form = new FormData();
  form.append('file', file);
  return requestForm<User>('/me/avatar', form, { endpoint: 'auth' });
}

export function deleteAvatar(): Promise<void> {
  return request<void>('/me/avatar', { method: 'DELETE', endpoint: 'auth' });
}
