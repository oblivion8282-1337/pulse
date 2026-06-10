/**
 * Backend-Client für den gewrappten Account-Key (Envelope-Encryption).
 *
 * Cookie-Auth (`pulse_session`) wie credentials.ts. Der Server speichert nur
 * Chiffretext: den mit dem KDF-abgeleiteten Wrap-Schlüssel AES-GCM-
 * verschlüsselten rohen Account-Key. NIE Passwort oder Klartext-AK senden/loggen.
 */

import { ApiError } from './client';
import { cookieFetch } from './cookie-client';

export interface AccountKeyPutRequest {
  wrapped_key: string; // base64 AES-GCM ciphertext der 32 AK-Bytes
  kdf_salt: string; // base64 16-byte salt
  kdf_params: string; // JSON string
  gcm_nonce: string; // base64 12-byte IV
  /** Ersetzen nur explizit (Passwort-Wechsel) — sonst 409 bei vorhandenem AK. */
  overwrite?: boolean;
}

export interface AccountKeyFetchResponse {
  wrapped_key: string;
  kdf_salt: string;
  kdf_params: string;
  gcm_nonce: string;
  created_at: string;
  updated_at: string;
}

/** Holt den gewrappten Account-Key. `null` wenn noch keiner existiert (404). */
export async function getAccountKey(): Promise<AccountKeyFetchResponse | null> {
  try {
    return await cookieFetch<AccountKeyFetchResponse>('/me/account-key');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Legt den gewrappten Account-Key an (oder ersetzt ihn mit overwrite=true). */
export async function putAccountKey(body: AccountKeyPutRequest): Promise<void> {
  await cookieFetch('/me/account-key', { method: 'PUT', body });
}
