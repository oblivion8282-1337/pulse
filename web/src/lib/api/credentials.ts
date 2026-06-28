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

import { cookieFetch } from './cookie-client';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface CredentialDevice {
  cert_id: string;
  device_label: string;
  issued_at: string;
  expires_at: string;
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
  profile_gradient_angle?: number | null;
}

export interface ProfileUpdateResponse {
  updated: string[];
  display_name: string | null;
  avatar_hash: string | null;
  profile_color: string | null;
  profile_color_secondary?: string | null;
  profile_gradient_angle?: number | null;
}

export interface UsernameChangeResponse {
  success: boolean;
  reserved_until: string;
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
