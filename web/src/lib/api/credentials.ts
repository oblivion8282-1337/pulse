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

import { AUTH_BASE, ApiError } from './client';

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
  avatar_hash?: string | null;
  profile_color?: string | null;
}

export interface ProfileUpdateResponse {
  updated: string[];
  display_name: string | null;
  avatar_hash: string | null;
  profile_color: string | null;
}

export interface UsernameChangeResponse {
  success: boolean;
  reserved_until: string;
}

// ---------------------------------------------------------------------------
// Interner Fetch-Helfer (Cookie-Auth, kein Bearer)
// ---------------------------------------------------------------------------

async function cookieFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = 'GET', body } = opts;
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(`${AUTH_BASE}${path}`, init);

  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  const data = text ? safeParse(text) : null;
  if (!resp.ok) {
    const detail = extractDetail(data);
    throw new ApiError(resp.status, data, detail ?? resp.statusText);
  }
  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractDetail(data: unknown): string | null {
  if (data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return null;
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
 * Aktualisiert Profil-Felder (display_name, avatar_hash, profile_color).
 * Sendet nur gesetzte Felder — nutze `model_fields_set`-Semantik.
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
