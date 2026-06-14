/**
 * Backend-Client für Cert/Credential-Endpoints (DE 11 Block 1.H).
 *
 * Alle Endpoints nutzen Cookie-Auth (`pulse_session` HttpOnly — automatisch
 * vom Browser mitgesendet). Bearer-Token ist hier nicht nötig.
 *
 * Wegen des Cookie-basierten Auth-Flows werden die Requests mit
 * `credentials: 'include'` abgeschickt — der Standard-`request()`-Wrapper
 * aus api/client.ts ist Bearer-only, daher direktes `fetch` hier.
 */

import { ApiError } from './client';
import { cookieFetch } from './cookie-client';
import type { KeyBackupBlob, KeyBackupBlobV1, KeyBackupBlobV2 } from '$lib/identity/key-backup.svelte';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface CredentialDevice {
  cert_id: string;
  device_label: string;
  issued_at: string;
  expires_at: string;
  has_backup: boolean;
}

export interface CredentialListResponse {
  devices: CredentialDevice[];
}

export interface CredentialIssueResponse {
  cert: string;
}

export interface ProfileStatementResponse {
  token: string;
}

export interface ProfileUpdatePayload {
  display_name?: string | null;
  // avatar_hash is deliberately not part of the update payload — the avatar is
  // changed via POST /me/avatar (image upload), and the backend ignores any
  // avatar_hash sent here. The response below still echoes the current hash.
  profile_color?: string | null;
  profile_color_secondary?: string | null;
}

export interface ProfileUpdateResponse {
  updated: string[];
  display_name: string | null;
  avatar_hash: string | null;
  profile_color: string | null;
  profile_color_secondary?: string | null;
}

export interface UsernameChangeResponse {
  success: boolean;
  reserved_until: string;
}

export interface BackupMetaResponse {
  cert_id: string;
  created_at: string;
  updated_at: string;
}

export interface BackupFetchResponse {
  cert_id: string;
  device_label: string;
  encrypted_blob: string;
  kdf_salt: string;
  kdf_params: string;
  gcm_nonce: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Öffentliche API-Funktionen
// ---------------------------------------------------------------------------

/**
 * Stellt ein neues Identitäts-Cert aus (oder gibt idempotent das bestehende zurück).
 *
 * @param pubkey - Base64URL-kodierter Ed25519-Public-Key (32 Bytes)
 * @param label  - Gerätebeschriftung (max. 64 Zeichen)
 * @param acr_values - Optional: `"mfa"` für Step-Up-Auth
 */
export async function issueCert(
  pubkey: string,
  label: string,
  acr_values?: string
): Promise<CredentialIssueResponse> {
  return cookieFetch<CredentialIssueResponse>('/credentials/issue', {
    method: 'POST',
    body: {
      device_pubkey: pubkey,
      device_label: label,
      ...(acr_values ? { acr_values } : {})
    }
  });
}

/**
 * Listet alle aktiven (nicht-revokierten, nicht-abgelaufenen) Certs des Users.
 */
export async function listCerts(): Promise<CredentialListResponse> {
  return cookieFetch<CredentialListResponse>('/credentials/list');
}

/**
 * Revokiert ein einzelnes Cert (z.B. Gerät abmelden).
 *
 * @param certId - UUID-String des Certs
 */
export async function revokeCert(certId: string): Promise<void> {
  return cookieFetch<void>(`/credentials/${certId}/revoke`, { method: 'POST' });
}

/**
 * Holt das aktuelle Profile-Statement JWT (24h-Gültigkeit).
 * Das Backend cached und refreshed intern — idempotent abrufbar.
 */
export async function getProfileStatement(): Promise<ProfileStatementResponse> {
  return cookieFetch<ProfileStatementResponse>('/credentials/profile-statement');
}

/**
 * Aktualisiert Profil-Felder (display_name, profile_color).
 * Sendet nur gesetzte Felder — nutze `model_fields_set`-Semantik.
 * (avatar_hash läuft separat über POST /me/avatar.)
 */
export async function updateProfile(data: ProfileUpdatePayload): Promise<ProfileUpdateResponse> {
  return cookieFetch<ProfileUpdateResponse>('/me/profile', {
    method: 'POST',
    body: data
  });
}

/**
 * Ändert den Benutzernamen.
 *
 * @param newName - Gewünschter neuer Benutzername
 */
export async function changeUsername(newName: string): Promise<UsernameChangeResponse> {
  return cookieFetch<UsernameChangeResponse>('/me/username', {
    method: 'POST',
    body: { new_username: newName }
  });
}

// ---------------------------------------------------------------------------
// Cloud-Backup (Block 2.A/2.C)
// ---------------------------------------------------------------------------

/** Platzhalter-Salt für v=3 (Account-Key, kein KDF) — Backend-Schema verlangt
 *  ein non-null Salt-Feld; 16 Null-Bytes als Konstante. */
const NO_SALT_B64 = 'AAAAAAAAAAAAAAAAAAAAAA==';

/**
 * Flacht einen KeyBackupBlob auf das Backend-API-Format ab.
 *
 * v=3 (AccountKey): kdf_params = { name: 'AccountKey' }, kdf_salt = Platzhalter
 * v=2 (Argon2id):   kdf_params = { name, parallelism, memory_kib, iterations }
 * v=1 (PBKDF2):     kdf_params = { name, hash, iterations }
 * Backend erwartet: { kdf_salt, kdf_params, gcm_nonce, encrypted_blob, device_label }
 */
function flattenBlob(blob: KeyBackupBlob, deviceLabel: string): Record<string, string> {
  let kdf_params: string;
  let kdf_salt: string;
  if (blob.v === 3) {
    kdf_params = JSON.stringify({ name: 'AccountKey' });
    kdf_salt = NO_SALT_B64;
  } else if (blob.v === 2) {
    kdf_params = JSON.stringify({
      name: blob.kdf.name,
      parallelism: blob.kdf.parallelism,
      memory_kib: blob.kdf.memory_kib,
      iterations: blob.kdf.iterations
    });
    kdf_salt = blob.kdf.salt;
  } else {
    kdf_params = JSON.stringify({
      name: blob.kdf.name,
      hash: blob.kdf.hash,
      iterations: blob.kdf.iterations
    });
    kdf_salt = blob.kdf.salt;
  }
  return {
    kdf_salt,
    kdf_params,
    gcm_nonce: blob.cipher.iv,
    encrypted_blob: blob.cipher.ct,
    device_label: deviceLabel
  };
}

/**
 * Rekonstruiert einen KeyBackupBlob aus dem Backend-Response-Format.
 * Parst kdf_params JSON-String zurück in die Blob-Struktur.
 * Unterstützt v=2 (Argon2id) und v=1 (PBKDF2 legacy).
 */
export function reconstructBlob(resp: BackupFetchResponse): KeyBackupBlob {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(resp.kdf_params) as Record<string, unknown>;
  } catch {
    // Fallback: leeres Objekt → PBKDF2 default
  }

  const cipher = { name: 'AES-GCM' as const, iv: resp.gcm_nonce, ct: resp.encrypted_blob };

  if (params.name === 'AccountKey') {
    return { v: 3, kdf: { name: 'AccountKey' }, cipher };
  }

  if (params.name === 'Argon2id') {
    const v2: KeyBackupBlobV2 = {
      v: 2,
      kdf: {
        name: 'Argon2id',
        parallelism: (typeof params.parallelism === 'number' ? params.parallelism : 4) as 4,
        memory_kib: (typeof params.memory_kib === 'number' ? params.memory_kib : 65536) as 65536,
        iterations: (typeof params.iterations === 'number' ? params.iterations : 3) as 3,
        salt: resp.kdf_salt
      },
      cipher
    };
    return v2;
  }

  // Fallback: PBKDF2 (v=1)
  const iterations =
    typeof params.iterations === 'number' ? (params.iterations as 600_000) : 600_000;
  const v1: KeyBackupBlobV1 = {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: resp.kdf_salt },
    cipher
  };
  return v1;
}

/**
 * Erstellt oder aktualisiert ein verschlüsseltes Keypair-Backup.
 *
 * @param certId      - UUID des Certs (aus certStore.cert.claims.cert_id)
 * @param blob        - Verschlüsselter KeyBackupBlob (aus encryptKeypair())
 * @param deviceLabel - Gerätebeschriftung (max. 64 Zeichen)
 */
export async function createBackup(
  certId: string,
  blob: KeyBackupBlob,
  deviceLabel: string
): Promise<BackupMetaResponse> {
  return cookieFetch<BackupMetaResponse>(`/credentials/${certId}/backup`, {
    method: 'POST',
    body: flattenBlob(blob, deviceLabel)
  });
}

/**
 * Holt das verschlüsselte Backup für ein Cert.
 * Gibt `null` zurück wenn kein Backup vorhanden ist (404).
 */
export async function getBackup(certId: string): Promise<BackupFetchResponse | null> {
  try {
    return await cookieFetch<BackupFetchResponse>(`/credentials/${certId}/backup`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Löscht das Backup für ein Cert.
 */
export async function deleteBackup(certId: string): Promise<void> {
  return cookieFetch<void>(`/credentials/${certId}/backup`, { method: 'DELETE' });
}
