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
