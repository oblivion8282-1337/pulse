/**
 * Identitäts-Cert-Halter (DE 11 A.1).
 *
 * Das Cert ist ein JWT, signiert von der Cloud mit RS256.
 * Es enthält: cert_id, user_id, device_pubkey, device_label,
 * pairwise_seed, amr, acr, iat, exp (~1 Jahr).
 *
 * Der private Schlüssel bleibt im Gerät (keypair.svelte.ts).
 * Backend-Calls (POST /credentials/issue) kommen in einem späteren Sub-Task.
 *
 * IndexedDB-Key: `pulse.identity-cert`
 */

import { openIdentityDb, idbGetIdentity, idbPutIdentity, STORE_NAME } from './idb-shared';

const CERT_KEY = 'pulse.identity-cert';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

/** Geparste Claims aus dem Cert-JWT-Payload (kein Signature-Check). */
export interface CertClaims {
  cert_id: string;
  user_id: string;
  device_pubkey: string;
  device_label?: string;
  pairwise_seed?: string;
  amr?: string[];
  acr?: string;
  iat: number;
  exp: number;
}

/**
 * Vollständiges Identitäts-Cert als in IndexedDB persistiertes Objekt.
 * `raw` = der rohe JWT-String für Challenge-Response-Flows.
 */
export interface IdentityCert {
  raw: string;
  claims: CertClaims;
}

// ---------------------------------------------------------------------------
// JWT-Payload-Parsing (kein Signature-Check — das macht das Backend)
// ---------------------------------------------------------------------------

/**
 * Dekodiert den Payload eines JWT (Base64URL → JSON).
 * Wirft NICHT — gibt `null` bei ungültigem JWT zurück.
 *
 * Signature-Verifikation passiert NICHT hier — das ist Aufgabe des Backends.
 */
export function parseCertClaims(jwt: string): CertClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded));
    // Minimale Validierung: Pflichtfelder
    if (
      typeof decoded.cert_id !== 'string' ||
      typeof decoded.user_id !== 'string' ||
      typeof decoded.exp !== 'number'
    ) {
      return null;
    }
    return decoded as CertClaims;
  } catch {
    return null;
  }
}

/** Gibt true zurück wenn das Cert in weniger als `thresholdSeconds` Sekunden abläuft. */
export function isCertExpiringSoon(cert: IdentityCert, thresholdSeconds = 30 * 24 * 3600): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  return cert.claims.exp - nowSec < thresholdSeconds;
}

/** Gibt true zurück wenn das Cert abgelaufen ist. */
export function isCertExpired(cert: IdentityCert): boolean {
  return Math.floor(Date.now() / 1000) >= cert.claims.exp;
}

// ---------------------------------------------------------------------------
// IndexedDB-Persistenz
// ---------------------------------------------------------------------------

/**
 * Lädt das Cert aus IndexedDB.
 * Gibt `null` zurück wenn kein Cert vorhanden ist.
 */
export async function loadCert(): Promise<IdentityCert | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openIdentityDb();
    const stored = (await idbGetIdentity(db, CERT_KEY)) as IdentityCert | undefined;
    db.close();
    if (!stored?.raw) return null;
    return stored;
  } catch {
    return null;
  }
}

/**
 * Persistiert das Cert in IndexedDB und aktualisiert den reaktiven State.
 */
export async function saveCert(cert: IdentityCert): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB nicht verfügbar');
  const db = await openIdentityDb();
  await idbPutIdentity(db, CERT_KEY, cert);
  db.close();
}

/**
 * Löscht das Cert aus IndexedDB (bei Logout / Keypair-Wipe).
 */
export async function wipeCert(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openIdentityDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(CERT_KEY);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Svelte-5-Runes-State (Singleton)
// ---------------------------------------------------------------------------

class CertStore {
  cert = $state<IdentityCert | null>(null);
  loaded = $state(false);

  async load(): Promise<void> {
    this.cert = await loadCert();
    this.loaded = true;
  }

  /**
   * Setzt und persistiert ein neues Cert.
   */
  async setCert(cert: IdentityCert): Promise<void> {
    await saveCert(cert);
    this.cert = cert;
  }

  get isExpiringSoon(): boolean {
    return this.cert !== null && isCertExpiringSoon(this.cert);
  }

  get isExpired(): boolean {
    return this.cert !== null && isCertExpired(this.cert);
  }

  async wipe(): Promise<void> {
    // In-Memory-Referenz SYNCHRON vor dem await leeren (gleiche Anti-Leak-
    // Reihenfolge wie keypairStore.wipe(): signOut() ruft
    // wipe() fire-and-forget; bliebe this.cert bis zum IDB-Delete gesetzt, läse
    // ein reaktiver Consumer (z.B. DeviceManagement) in diesem Fenster noch das
    // Cert des Vorgängers. Auch robuster bei IDB-Fehler.
    this.cert = null;
    await wipeCert();
  }
}

export const certStore = new CertStore();
