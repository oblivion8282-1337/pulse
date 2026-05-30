import { request, requestForm, resetRefreshLock } from './client';
import { saveTokens } from './storage';
import type { Session, Tokens, User } from './types';

/**
 * The /login endpoint returns one of two shapes:
 *  - `Tokens` (normal flow) — saved + the auth-store can hydrate.
 *  - `MfaChallenge` — the account has a second factor; the caller completes
 *    via `loginWithTotp(...)` or `loginWithPasskey(mfa_ticket)`.
 *
 * The discriminator is `requires_mfa: true`. `methods` lists which second
 * factors the account actually has, so the UI shows only the relevant inputs:
 * a passkey-only account is `["webauthn"]` and never sees a code field.
 */
export type MfaMethod = 'totp' | 'webauthn';

export type MfaChallenge = {
  requires_mfa: true;
  mfa_ticket: string;
  methods: MfaMethod[];
};

export type LoginResult = Tokens | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return 'requires_mfa' in result && result.requires_mfa === true;
}

export type TotpSetup = {
  secret: string;
  qr_png_base64: string;
  provisioning_uri: string;
};

export type BackupCodes = {
  backup_codes: string[];
};

export async function register(payload: {
  username: string;
  email: string;
  password: string;
  display_name?: string | null;
  invite_code?: string | null;
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

export async function login(emailOrUsername: string, password: string): Promise<LoginResult> {
  const result = await request<LoginResult>('/login', {
    method: 'POST',
    body: { email_or_username: emailOrUsername, password },
    auth: false,
    endpoint: 'auth'
  });
  if (!isMfaChallenge(result)) {
    saveTokens(result);
    resetRefreshLock();
  }
  return result;
}

/** Second step of the TOTP-gated login. Exactly one of `code` / `backup_code`
 *  must be provided. Server validates the `mfa_ticket` (short-lived JWT). */
export async function loginWithTotp(
  mfaTicket: string,
  args: { code?: string; backup_code?: string }
): Promise<Tokens> {
  const body: Record<string, string> = { mfa_ticket: mfaTicket };
  if (args.code) body.code = args.code;
  if (args.backup_code) body.backup_code = args.backup_code;
  const tokens = await request<Tokens>('/login/totp', {
    method: 'POST',
    body,
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

// --- password reset (unauthenticated) ---------------------------------------

/** Always 204 — backend deliberately doesn't reveal whether the address
 *  matched a user (enumeration prevention). UI shows a generic confirmation. */
export async function passwordForgot(emailOrUsername: string): Promise<void> {
  await request<void>('/password/forgot', {
    method: 'POST',
    body: { email_or_username: emailOrUsername },
    auth: false,
    endpoint: 'auth'
  });
}

export async function passwordReset(token: string, newPassword: string): Promise<void> {
  await request<void>('/password/reset', {
    method: 'POST',
    body: { token, new_password: newPassword },
    auth: false,
    endpoint: 'auth'
  });
}

// --- authenticated credential changes ---------------------------------------

/** Change the password while logged in. Requires the current password; the
 *  server logs out all OTHER devices and returns a fresh token pair for THIS
 *  device, which we persist so the active session keeps working. */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const tokens = await request<Tokens>('/me/password', {
    method: 'POST',
    body: { current_password: currentPassword, new_password: newPassword },
    endpoint: 'auth'
  });
  saveTokens(tokens);
}

/** Request an email-address change. Requires the current password. Sends a
 *  confirmation link to the NEW address; the change only applies once that link
 *  is clicked (confirmEmailChange). Resolves on 204. */
export async function changeEmail(newEmail: string, currentPassword: string): Promise<void> {
  await request<void>('/me/email/change', {
    method: 'POST',
    body: { new_email: newEmail, current_password: currentPassword },
    endpoint: 'auth'
  });
}

/** Public — finalises an email change via the token from the verification link. */
export async function confirmEmailChange(token: string): Promise<void> {
  await request<void>('/me/email/change/confirm', {
    method: 'POST',
    body: { token },
    auth: false,
    endpoint: 'auth'
  });
}

// --- email verification -----------------------------------------------------

/** Authenticated: server re-sends the verification link to the current user. */
export async function emailVerifySend(): Promise<void> {
  await request<void>('/email/verification/send', {
    method: 'POST',
    endpoint: 'auth'
  });
}

/** Public — link is single-use and self-authenticates via the token JWT. */
export async function emailVerifyConfirm(token: string): Promise<void> {
  await request<void>('/email/verification/confirm', {
    method: 'POST',
    body: { token },
    auth: false,
    endpoint: 'auth'
  });
}

// --- TOTP / 2FA -------------------------------------------------------------

export async function totpSetup(): Promise<TotpSetup> {
  return request<TotpSetup>('/totp/setup', { method: 'POST', endpoint: 'auth' });
}

export async function totpVerifySetup(code: string): Promise<BackupCodes> {
  return request<BackupCodes>('/totp/verify-setup', {
    method: 'POST',
    body: { code },
    endpoint: 'auth'
  });
}

/** Disable TOTP. Server requires password + one of (current TOTP code | backup code). */
export async function totpDisable(
  password: string,
  args: { code?: string; backup_code?: string }
): Promise<void> {
  const body: Record<string, string> = { password };
  if (args.code) body.code = args.code;
  if (args.backup_code) body.backup_code = args.backup_code;
  await request<void>('/totp/disable', {
    method: 'POST',
    body,
    endpoint: 'auth'
  });
}

export async function totpBackupRegenerate(password: string, code: string): Promise<BackupCodes> {
  return request<BackupCodes>('/totp/backup-codes/regenerate', {
    method: 'POST',
    body: { password, code },
    endpoint: 'auth'
  });
}

// --- active sessions --------------------------------------------------------

/** List all active refresh-token sessions for the current user. The server
 *  marks one as `is_current: true` via UA + IP-hash heuristic. */
export async function listSessions(): Promise<Session[]> {
  return request<Session[]>('/sessions', { endpoint: 'auth' });
}

/** Revoke a single session by id. Server returns 204 on success, 404 if the
 *  session belongs to someone else (defense in depth — should not happen). */
export async function revokeSession(id: string): Promise<void> {
  await request<void>(`/sessions/${id}`, { method: 'DELETE', endpoint: 'auth' });
}

/** Revoke every session except the current one. Returns the count for the
 *  toast — useful as both UX feedback and a sanity check. */
export async function revokeOtherSessions(): Promise<{ revoked_count: number }> {
  return request<{ revoked_count: number }>('/sessions', {
    method: 'DELETE',
    endpoint: 'auth'
  });
}

// --- account deletion (Gefahrenzone) ----------------------------------------

/**
 * Hard-delete the current user — irreversibly removes the profile, all
 * messages, memberships, owned guilds and 2FA state. Server requires the
 * current password + (if 2FA is enabled) one of (code | backup_code) + an
 * explicit `confirm_username` that must exactly match the user's own
 * username. The 204-on-success contract leaves the caller responsible for
 * signing out + redirecting; the access token is invalid after the call
 * regardless of what the caller does.
 *
 * Error mapping documented next to the call site in the dialog — we just
 * forward the server's `detail` via `ApiError.message` for the toast.
 */
export async function deleteAccount(input: {
  password: string;
  code?: string;
  backup_code?: string;
  confirm_username: string;
}): Promise<void> {
  const body: Record<string, string> = {
    password: input.password,
    confirm_username: input.confirm_username
  };
  if (input.code) body.code = input.code;
  if (input.backup_code) body.backup_code = input.backup_code;
  await request<void>('/me', {
    method: 'DELETE',
    body,
    endpoint: 'auth'
  });
}
