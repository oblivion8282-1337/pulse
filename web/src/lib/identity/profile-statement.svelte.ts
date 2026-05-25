/**
 * Profile-Statement-Halter (DE 11 A.2).
 *
 * Das Profile-Statement ist ein JWT, signiert von der Cloud (RS256).
 * Validity: ~24h. Enthält: statement_id, user_id, username, display_name,
 * avatar_hash, profile_color, iat, exp.
 *
 * Frontend holt Statement initial nach Cert-Issuance + refreshed
 * automatisch 4h vor Expiry (A.2 Background-Timer — TODO in späterem Sub-Task).
 * Backend-Calls kommen in einem späteren Sub-Task.
 *
 * IndexedDB-Key: `pulse.profile-statement`
 */

import { openIdentityDb, idbGetIdentity, idbPutIdentity } from './idb-shared';

const STATEMENT_KEY = 'pulse.profile-statement';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

/** Geparste Claims aus dem Profile-Statement-JWT-Payload. */
export interface ProfileStatementClaims {
  statement_id: string;
  user_id: string;
  username: string;
  display_name?: string;
  avatar_hash?: string;
  profile_color?: string;
  iat: number;
  exp: number;
}

/**
 * Vollständiges Profile-Statement als in IndexedDB persistiertes Objekt.
 */
export interface ProfileStatement {
  raw: string;
  claims: ProfileStatementClaims;
}

// ---------------------------------------------------------------------------
// JWT-Payload-Parsing
// ---------------------------------------------------------------------------

/**
 * Dekodiert den Payload eines Profile-Statement-JWT.
 * Gibt `null` bei ungültigem JWT zurück. Kein Signature-Check.
 */
export function parseStatementClaims(jwt: string): ProfileStatementClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded));
    if (
      typeof decoded.statement_id !== 'string' ||
      typeof decoded.user_id !== 'string' ||
      typeof decoded.username !== 'string' ||
      typeof decoded.exp !== 'number'
    ) {
      return null;
    }
    return decoded as ProfileStatementClaims;
  } catch {
    return null;
  }
}

/** Gibt true zurück wenn das Statement abgelaufen ist. */
export function isStatementExpired(statement: ProfileStatement): boolean {
  return Math.floor(Date.now() / 1000) >= statement.claims.exp;
}

/**
 * Gibt true zurück wenn das Statement in weniger als `thresholdSeconds` Sekunden abläuft.
 * Default: 4h (= Refresh-Trigger laut A.2).
 */
export function isStatementExpiringSoon(
  statement: ProfileStatement,
  thresholdSeconds = 4 * 3600
): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  return statement.claims.exp - nowSec < thresholdSeconds;
}

// ---------------------------------------------------------------------------
// IndexedDB-Persistenz
// ---------------------------------------------------------------------------

export async function loadProfileStatement(): Promise<ProfileStatement | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openIdentityDb();
    const stored = (await idbGetIdentity(db, STATEMENT_KEY)) as ProfileStatement | undefined;
    db.close();
    if (!stored?.raw) return null;
    return stored;
  } catch {
    return null;
  }
}

export async function saveProfileStatement(statement: ProfileStatement): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB nicht verfügbar');
  const db = await openIdentityDb();
  await idbPutIdentity(db, STATEMENT_KEY, statement);
  db.close();
}

export async function wipeProfileStatement(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openIdentityDb();
    const tx = db.transaction('identity', 'readwrite');
    tx.objectStore('identity').delete(STATEMENT_KEY);
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

class ProfileStatementStore {
  statement = $state<ProfileStatement | null>(null);
  loaded = $state(false);

  async load(): Promise<void> {
    this.statement = await loadProfileStatement();
    this.loaded = true;
  }

  async setStatement(statement: ProfileStatement): Promise<void> {
    await saveProfileStatement(statement);
    this.statement = statement;
  }

  getStatementOrNull(): ProfileStatement | null {
    return this.statement;
  }

  get isExpired(): boolean {
    return this.statement !== null && isStatementExpired(this.statement);
  }

  get isExpiringSoon(): boolean {
    return this.statement !== null && isStatementExpiringSoon(this.statement);
  }

  async wipe(): Promise<void> {
    await wipeProfileStatement();
    this.statement = null;
  }
}

export const profileStatementStore = new ProfileStatementStore();
