/**
 * WebAuthn / passkey ceremonies — browser side.
 *
 * No JS dependency: the base64url <-> ArrayBuffer conversion the native
 * `navigator.credentials` API needs is hand-rolled below. The server speaks
 * the standard `@simplewebauthn`-compatible JSON shape, so `py_webauthn` on
 * the backend parses our serialized credential directly.
 *
 * Two ceremonies, each an options -> verify round-trip:
 *  - registration (authenticated): enrol a new passkey on the account.
 *  - login: either the 2FA second step (with `mfaTicket`) or a full
 *    passwordless sign-in (without one).
 */
import { request, resetRefreshLock } from './client';
import { saveTokens } from './storage';
import type { Tokens } from './types';

export type WebAuthnCredentialSummary = {
  id: string;
  name: string;
  aaguid: string | null;
  transports: string[] | null;
  created_at: string;
  last_used_at: string | null;
};

type OptionsResponse = { options: Record<string, any>; challenge_ticket: string };

/** True when this browser exposes the WebAuthn API at all. */
export function webauthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator?.credentials?.create === 'function'
  );
}

/** Best-effort: is a built-in authenticator (Touch ID / Windows Hello)
 *  available? Used only to tailor copy — never to gate functionality. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!webauthnSupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ---- base64url <-> ArrayBuffer ---------------------------------------------

function b64urlToBuf(value: string): ArrayBuffer {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- options decode / credential encode ------------------------------------

/** Map the server's JSON options into the BufferSource-typed shape that
 *  `navigator.credentials.create` requires. */
function decodeCreationOptions(o: Record<string, any>): PublicKeyCredentialCreationOptions {
  return {
    ...o,
    challenge: b64urlToBuf(o.challenge),
    user: { ...o.user, id: b64urlToBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map((c: Record<string, any>) => ({
      ...c,
      id: b64urlToBuf(c.id),
    })),
  } as PublicKeyCredentialCreationOptions;
}

function decodeRequestOptions(o: Record<string, any>): PublicKeyCredentialRequestOptions {
  return {
    ...o,
    challenge: b64urlToBuf(o.challenge),
    allowCredentials: (o.allowCredentials ?? []).map((c: Record<string, any>) => ({
      ...c,
      id: b64urlToBuf(c.id),
    })),
  } as PublicKeyCredentialRequestOptions;
}

/** Serialize the attestation from `create()` into the server's JSON shape. */
function encodeRegistration(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: bufToB64url(r.attestationObject),
      transports: r.getTransports?.() ?? []
    }
  };
}

/** Serialize the assertion from `get()` into the server's JSON shape. */
function encodeAssertion(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      authenticatorData: bufToB64url(r.authenticatorData),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : null
    }
  };
}

/** Turn the WebAuthn API's `DOMException`s into German user-facing copy.
 *  `NotAllowedError` covers both an explicit cancel and a ceremony timeout —
 *  the browser deliberately doesn't distinguish them (privacy). */
function ceremonyError(err: unknown): Error {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError')
      return new Error('Abgebrochen oder Zeitüberschreitung — bitte erneut versuchen.');
    if (err.name === 'InvalidStateError')
      return new Error('Dieser Authenticator ist bereits als Passkey registriert.');
    if (err.name === 'SecurityError')
      return new Error('Passkeys funktionieren nur über eine sichere Verbindung (HTTPS).');
  }
  return err instanceof Error ? err : new Error('Passkey-Vorgang fehlgeschlagen.');
}

// ---- registration (authenticated) ------------------------------------------

/** Enrol a new passkey. `backup_codes` is non-null only when this is the
 *  account's first MFA factor — the caller must then show them once. */
export async function registerPasskey(
  name: string
): Promise<{ credential: WebAuthnCredentialSummary; backup_codes: string[] | null }> {
  const opts = await request<OptionsResponse>('/webauthn/register/options', {
    method: 'POST',
    endpoint: 'auth'
  });
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create({
      publicKey: decodeCreationOptions(opts.options)
    });
  } catch (err) {
    throw ceremonyError(err);
  }
  if (!cred) throw new Error('Passkey-Erstellung abgebrochen.');
  return request('/webauthn/register/verify', {
    method: 'POST',
    endpoint: 'auth',
    body: {
      challenge_ticket: opts.challenge_ticket,
      credential: encodeRegistration(cred as PublicKeyCredential),
      name
    }
  });
}

// ---- login -----------------------------------------------------------------

/** Complete a login with a passkey. With `mfaTicket` it is the second factor
 *  of a password login; without one it is a full passwordless sign-in.
 *  Saves the tokens on success, mirroring `loginWithTotp`. */
export async function loginWithPasskey(mfaTicket?: string): Promise<Tokens> {
  const opts = await request<OptionsResponse>('/login/webauthn/options', {
    method: 'POST',
    endpoint: 'auth',
    auth: false,
    body: mfaTicket ? { mfa_ticket: mfaTicket } : {}
  });
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.get({
      publicKey: decodeRequestOptions(opts.options)
    });
  } catch (err) {
    throw ceremonyError(err);
  }
  if (!cred) throw new Error('Passkey-Anmeldung abgebrochen.');
  const tokens = await request<Tokens>('/login/webauthn/verify', {
    method: 'POST',
    endpoint: 'auth',
    auth: false,
    body: {
      challenge_ticket: opts.challenge_ticket,
      credential: encodeAssertion(cred as PublicKeyCredential),
      ...(mfaTicket ? { mfa_ticket: mfaTicket } : {})
    }
  });
  saveTokens(tokens);
  resetRefreshLock();
  return tokens;
}

// ---- management (authenticated) --------------------------------------------

export function listPasskeys(): Promise<WebAuthnCredentialSummary[]> {
  return request<WebAuthnCredentialSummary[]>('/webauthn/credentials', { endpoint: 'auth' });
}

export function renamePasskey(id: string, name: string): Promise<WebAuthnCredentialSummary> {
  return request<WebAuthnCredentialSummary>(`/webauthn/credentials/${id}`, {
    method: 'PATCH',
    body: { name },
    endpoint: 'auth'
  });
}

export function deletePasskey(id: string): Promise<void> {
  return request<void>(`/webauthn/credentials/${id}`, { method: 'DELETE', endpoint: 'auth' });
}
