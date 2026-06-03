/**
 * Backend-Client für den Zero-Knowledge Server-Vault (E2E-Sync der Server-Liste).
 *
 * Cookie-Auth (`pulse_session`) wie credentials.ts — der Server speichert nur
 * Chiffretext, nie die Klartext-Server-Liste oder das Master-Passwort.
 */

import { ApiError } from './client';
import { cookieFetch } from './cookie-client';

export interface ServerVaultPutRequest {
  encrypted_blob: string; // base64 AES-GCM ciphertext
  kdf_salt: string; // base64 16-byte salt
  kdf_params: string; // JSON string
  gcm_nonce: string; // base64 12-byte IV
}

export interface ServerVaultMetaResponse {
  created_at: string;
  updated_at: string;
}

export interface ServerVaultFetchResponse {
  encrypted_blob: string;
  kdf_salt: string;
  kdf_params: string;
  gcm_nonce: string;
  created_at: string;
  updated_at: string;
}

/** Legt den verschlüsselten Server-Vault an oder ersetzt ihn (ein Slot pro User). */
export async function putServerVault(
  body: ServerVaultPutRequest
): Promise<ServerVaultMetaResponse> {
  return cookieFetch<ServerVaultMetaResponse>('/server-vault', { method: 'PUT', body });
}

/** Holt den verschlüsselten Server-Vault. Gibt `null` zurück wenn keiner existiert (404). */
export async function getServerVault(): Promise<ServerVaultFetchResponse | null> {
  try {
    return await cookieFetch<ServerVaultFetchResponse>('/server-vault');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Löscht den Server-Vault. */
export async function deleteServerVault(): Promise<void> {
  return cookieFetch<void>('/server-vault', { method: 'DELETE' });
}
