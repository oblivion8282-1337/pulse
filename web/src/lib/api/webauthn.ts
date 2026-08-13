/**
 * WebAuthn / passkey ceremonies — browser side.
 *
 * No JS dependency: the base64url <-> bytes conversion the native
 * `navigator.credentials` API needs comes from `$lib/utils/base64url`. The
 * server speaks the standard `@simplewebauthn`-compatible JSON shape, so
 * `py_webauthn` on the backend parses our serialized credential directly.
 *
 * Two ceremonies, each an options -> verify round-trip:
 *  - registration (authenticated): enrol a new passkey on the account.
 *  - login: either the 2FA second step (with `mfaTicket`) or a full
 *    passwordless sign-in (without one).
 */
import { base64UrlDecode, base64UrlEncode } from '$lib/utils/base64url';
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

// ---- options decode / credential encode ------------------------------------

/** Map the server's JSON options into the BufferSource-typed shape that
 *  `navigator.credentials.create` requires. */
function decodeCreationOptions(o: Record<string, any>): PublicKeyCredentialCreationOptions {
  return {
    ...o,
    challenge: base64UrlDecode(o.challenge).buffer,
    user: { ...o.user, id: base64UrlDecode(o.user.id).buffer },
    excludeCredentials: (o.excludeCredentials ?? []).map((c: Record<string, any>) => ({
      ...c,
      id: base64UrlDecode(c.id).buffer,
    })),
  } as PublicKeyCredentialCreationOptions;
}

function decodeRequestOptions(o: Record<string, any>): PublicKeyCredentialRequestOptions {
  return {
    ...o,
    challenge: base64UrlDecode(o.challenge).buffer,
    allowCredentials: (o.allowCredentials ?? []).map((c: Record<string, any>) => ({
      ...c,
      id: base64UrlDecode(c.id).buffer,
    })),
  } as PublicKeyCredentialRequestOptions;
}

/** Serialize the attestation from `create()` into the server's JSON shape. */
function encodeRegistration(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: base64UrlEncode(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: base64UrlEncode(r.clientDataJSON),
      attestationObject: base64UrlEncode(r.attestationObject),
      transports: r.getTransports?.() ?? []
    }
  };
}

/** Serialize the assertion from `get()` into the server's JSON shape. */
function encodeAssertion(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: base64UrlEncode(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: base64UrlEncode(r.clientDataJSON),
      authenticatorData: base64UrlEncode(r.authenticatorData),
      signature: base64UrlEncode(r.signature),
      userHandle: r.userHandle ? base64UrlEncode(r.userHandle) : null
    }
  };
}

/** Turn the WebAuthn API's `DOMException`s into German user-facing copy.
 *  `NotAllowedError` covers both an explicit cancel and a ceremony timeout —
 *  the browser deliberately doesn't distinguish them (privacy).
 *  `SecurityError` is *not* only a missing-HTTPS problem: the browser raises
 *  it just as well when the server's rpId is not a registrable suffix of the
 *  current origin (WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN misconfigured) — so the
 *  copy names both causes instead of blaming the connection. */
function ceremonyError(err: unknown): Error {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError')
      return new Error('Abgebrochen oder Zeitüberschreitung — bitte erneut versuchen.');
    if (err.name === 'InvalidStateError')
      return new Error('Dieser Authenticator ist bereits als Passkey registriert.');
    if (err.name === 'SecurityError')
      return new Error(
        'Passkey nicht möglich: Die Seite muss über HTTPS laufen und die ' +
          'Server-Domain (rpId/Origin) muss zur aufgerufenen Adresse passen.'
      );
  }
  return err instanceof Error ? err : new Error('Passkey-Vorgang fehlgeschlagen.');
}

// ---- registration (authenticated) ------------------------------------------

/** Enrol a new passkey. `backup_codes` is non-null only when this is the
 *  account's first MFA factor — the caller must then show them once. */
/** Passkey anlegen. `password` ist seit 2026-08-13 Pflicht: ein
 *  untergeschobener Sicherheitsschlüssel wäre eine dauerhafte Kontoübernahme —
 *  der Angreifer meldet sich danach passwortlos an, auch nachdem das gestohlene
 *  Token abgelaufen ist und der echte Inhaber sein Passwort geändert hat (das
 *  entfernt fremde Schlüssel nicht). Das Abschalten von 2FA verlangte es längst. */
export async function registerPasskey(
  name: string,
  password: string
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
      name,
      password
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

/** Passkey löschen. `password` ist Pflicht: das Löschen des LETZTEN Schlüssels
 *  nimmt dem Konto seinen zweiten Faktor mit — es war damit der stillste Weg,
 *  ein fremdes Konto zu entschärfen. */
export function deletePasskey(id: string, password: string): Promise<void> {
  return request<void>(`/webauthn/credentials/${id}`, {
    method: 'DELETE',
    body: { password },
    endpoint: 'auth'
  });
}
