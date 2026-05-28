/**
 * Ed25519-Keypair-Verwaltung für das Identitäts-Cert-Modell (DE 11 A.1).
 *
 * Strategie:
 *   1. WebCrypto-Ed25519 (Chrome 113+, Firefox 130+, Safari 17+) — non-extractable privater Schlüssel.
 *   2. Wenn Ed25519 über WebCrypto nicht verfügbar: TODO(ADD DEP @noble/curves) — benötigt
 *      `pnpm add @noble/curves`. Bis zur Entscheidung wirft der Fallback einen klaren Fehler.
 *
 * IndexedDB-Key: `pulse.keypair`
 * Format im Store: `{ type: 'webcrypto', publicKey: CryptoKey, privateKey: CryptoKey }`
 *                   oder später `{ type: 'noble', publicKey: Uint8Array, privateKey: Uint8Array }`
 */

import { openIdentityDb, idbGetIdentity, idbPutIdentity, STORE_NAME } from './idb-shared';

const IDB_KEY = 'pulse.keypair';

// ---------------------------------------------------------------------------
// WebCrypto-Support-Detection
// ---------------------------------------------------------------------------

/**
 * Prüft ob WebCrypto Ed25519 im aktuellen Browser verfügbar ist.
 * Chrome 113+, Firefox 130+, Safari 17+. Electron 42 (Chromium 130) = ✓.
 */
export async function supportsWebCryptoEd25519(): Promise<boolean> {
  try {
    if (typeof window === 'undefined') return false;
    if (!window.crypto?.subtle) return false;
    // Minimal-Test: Keypair generieren und sofort verwerfen
    await window.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Öffentliche Keypair-Typen
// ---------------------------------------------------------------------------

/** WebCrypto-Keypair. */
export interface WebCryptoKeypair {
  type: 'webcrypto';
  publicKey: CryptoKey;
  /**
   * `extractable: true` seit Block 2.E — ermöglicht Cloud-Backup ohne Re-Login.
   * Ältere Keys (vor diesem Patch) können `extractable: false` sein; der Backup-Flow
   * zeigt in dem Fall eine "Bitte neu anmelden"-Meldung.
   */
  privateKey: CryptoKey;
}

/** Serialisierte Form für IndexedDB (CryptoKey-Objekte sind direkt speicherbar). */
export type StoredKeypair = WebCryptoKeypair;

// ---------------------------------------------------------------------------
// Core-Funktionen
// ---------------------------------------------------------------------------

/**
 * Generiert ein neues Ed25519-Keypair.
 *
 * Ab Block 2.E: privater Schlüssel ist immer `extractable: true`. Begründung:
 * - Cloud-Backup ist Standard-Use-Case — kein Re-Login vor dem ersten Backup nötig.
 * - Das private-key-Material liegt ohnehin in JS-RAM während Signing-Ops (kein
 *   WebAuthn-style HW-Isolation), der Trade-off ist überschaubar.
 * - Ältere Keys (vor diesem Patch) können `extractable: false` sein; der Backup-Flow
 *   zeigt in dem Fall: "Bitte einmal neu anmelden".
 *
 * Der `forBackup`-Parameter wird aus Kompatibilitätsgründen noch akzeptiert, hat aber
 * keinen Effekt mehr — `extractable` ist immer `true`.
 *
 * Wirft `Error('ED25519_WEBCRYPTO_UNSUPPORTED')` wenn WebCrypto Ed25519
 * nicht verfügbar ist.
 */
export async function generateKeypair(opts?: { forBackup?: boolean }): Promise<WebCryptoKeypair> {
  void opts; // forBackup-Parameter ohne Effekt — extractable ist immer true (Block 2.E)
  if (!(await supportsWebCryptoEd25519())) {
    // FINAL-DECISION (User, Block 1.F-Verify): kein Fallback auf @noble/curves.
    // Browsers ohne nativen Ed25519-Support (Safari < 17, Firefox < 130, alte
    // Chromium) bekommen ED25519_WEBCRYPTO_UNSUPPORTED. Plan-Sectionvermerk:
    // "Hard-Cut, moderne Browser only".
    throw new Error('ED25519_WEBCRYPTO_UNSUPPORTED');
  }

  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true, // extractable: immer true seit Block 2.E (Backup-Default)
    ['sign', 'verify']
  );

  return {
    type: 'webcrypto',
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey
  };
}

/**
 * Lädt das gespeicherte Keypair aus IndexedDB.
 * Gibt `null` zurück wenn kein Keypair vorhanden ist.
 */
export async function loadKeypair(): Promise<StoredKeypair | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openIdentityDb();
    const stored = (await idbGetIdentity(db, IDB_KEY)) as StoredKeypair | undefined;
    db.close();
    if (!stored || !stored.type) return null;
    return stored;
  } catch {
    return null;
  }
}

/**
 * Persistiert ein Keypair in IndexedDB.
 * CryptoKey-Objekte sind direkt in IndexedDB speicherbar (Structured Clone Algorithm).
 */
export async function saveKeypair(keys: StoredKeypair): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB nicht verfügbar');
  const db = await openIdentityDb();
  await idbPutIdentity(db, IDB_KEY, keys);
  db.close();
}

/**
 * Signiert eine Challenge mit dem privaten Schlüssel.
 * Gibt die Signatur als Uint8Array zurück (64 Bytes bei Ed25519).
 *
 * Wirft wenn kein Keypair geladen ist.
 */
export async function signChallenge(
  keys: StoredKeypair,
  challenge: Uint8Array
): Promise<Uint8Array> {
  if (keys.type === 'webcrypto') {
    // challenge.buffer kann SharedArrayBuffer sein — neuer ArrayBuffer via Uint8Array.slice()
    const buf: ArrayBuffer = challenge.slice().buffer;
    const sig = await window.crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, buf);
    return new Uint8Array(sig);
  }
  throw new Error('Unbekannter Keypair-Typ');
}

/**
 * Exportiert den Public-Key als Base64-URL-encoded String für den
 * Cert-Issue-Request (`POST /credentials/issue`).
 * Exportiert im Raw-Format (32 Bytes Ed25519-Punkt).
 */
export async function exportPublicKey(keys: StoredKeypair): Promise<string> {
  if (keys.type === 'webcrypto') {
    const raw = await window.crypto.subtle.exportKey('raw', keys.publicKey);
    return uint8ToBase64Url(new Uint8Array(raw));
  }
  throw new Error('Unbekannter Keypair-Typ');
}

/**
 * Löscht das Keypair aus IndexedDB ("Public-Computer-Safety"-Flow).
 * Nach diesem Aufruf ist kein Cert-Auth mehr möglich bis ein neues Keypair generiert wird.
 */
export async function wipeKeypair(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openIdentityDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(IDB_KEY);
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
// Svelte-5-Runes-State (Singleton, reaktiver Wrapper)
// ---------------------------------------------------------------------------

class KeypairStore {
  keypair = $state<StoredKeypair | null>(null);
  loaded = $state(false);

  async load(): Promise<void> {
    this.keypair = await loadKeypair();
    this.loaded = true;
  }

  async generate(): Promise<StoredKeypair> {
    const kp = await generateKeypair();
    await saveKeypair(kp);
    this.keypair = kp;
    return kp;
  }

  async wipe(): Promise<void> {
    await wipeKeypair();
    this.keypair = null;
  }

  get hasKeypair(): boolean {
    return this.keypair !== null;
  }
}

export const keypairStore = new KeypairStore();

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function uint8ToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
