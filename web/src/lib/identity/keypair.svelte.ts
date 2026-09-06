/**
 * Ed25519-Keypair-Verwaltung für das Identitäts-Cert-Modell (DE 11 A.1).
 *
 * Strategie: ausschließlich WebCrypto-Ed25519 (Chrome 113+, Firefox 130+,
 * Safari 17+) mit non-extractable privatem Schlüssel. Browser ohne nativen
 * Ed25519-Support bekommen `ED25519_WEBCRYPTO_UNSUPPORTED` — bewusster
 * Hard-Cut, KEIN Software-Fallback (FINAL-DECISION in `generateKeypair`, kein
 * `@noble/curves`).
 *
 * IndexedDB-Key: `pulse.keypair`
 * Format im Store: `{ type: 'webcrypto', publicKey: CryptoKey, privateKey: CryptoKey }`
 */

import { openIdentityDb, idbGetIdentity, idbPutIdentity, STORE_NAME } from './idb-shared';
import { dauerhaftenSpeicherAnfordern } from './dauerhafterSpeicher';

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
   * Immer `extractable: false` — verhindert JS-Export via exportKey (XSS-Schutz).
   * Kein anderer Konsument im Repo; das frühere Backup-Feature, das exportable
   * Keypairs brauchte, ist entfernt.
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
 * Privater Schlüssel ist immer `extractable: false` — verhindert JS-seitigen
 * Export via `crypto.subtle.exportKey` (XSS-Schutz).
 *
 * Wirft `Error('ED25519_WEBCRYPTO_UNSUPPORTED')` wenn WebCrypto Ed25519
 * nicht verfügbar ist.
 */
export async function generateKeypair(): Promise<WebCryptoKeypair> {
  if (!(await supportsWebCryptoEd25519())) {
    // FINAL-DECISION (User, Block 1.F-Verify): kein Fallback auf @noble/curves.
    // Browsers ohne nativen Ed25519-Support (Safari < 17, Firefox < 130, alte
    // Chromium) bekommen ED25519_WEBCRYPTO_UNSUPPORTED. Plan-Sectionvermerk:
    // "Hard-Cut, moderne Browser only".
    throw new Error('ED25519_WEBCRYPTO_UNSUPPORTED');
  }

  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false, // extractable: false — XSS kann den privaten Schlüssel nicht exportieren
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
 *
 * Gibt `null` NUR für den echten Normalfall zurück: kein `indexedDB` in
 * dieser Umgebung (SSR), oder ein geöffneter Store ohne Eintrag unter
 * `IDB_KEY` (frischer Browser, nie ein Keypair erzeugt) — „dieses Gerät hat
 * (noch) keinen Schlüssel" ist ein legitimer Zustand, den Aufrufer wie
 * `krypto/senden.ts` als Koexistenz-Fall behandeln dürfen.
 *
 * **Wirft dagegen bei jedem Fehler, der beim NACHSEHEN selbst auftritt**
 * (IDB blockiert, `QuotaExceededError`, ein `InvalidStateError`-Rennen wie
 * es `verlauf/db.ts::mitVerbindung` für die Verlaufs-DB heilt — hier gibt es
 * diese Heilung nicht, s. dortigen Modulkopf). Ein blankes `catch { return
 * null }` machte diesen Fall früher ununterscheidbar vom Normalfall: der
 * Aufrufer in `senden.ts` deutete jeden Lesefehler als "kein Schlüssel" und
 * sendete im Klartext, ohne Warnung — derselbe Fehlertyp wie beim
 * pauschalen `.catch(() => null)`, den es in `senden.ts` selbst schon
 * einmal gab (s. dortigen Modulkopf, Bughunt 2026-08-28). Aufrufer, die
 * einen Lesefehler NICHT wie „kein Schlüssel" behandeln dürfen, fangen den
 * Wurf selbst ab und machen ihn sichtbar statt ihn stillschweigend
 * weiterzureichen.
 */
export async function loadKeypair(): Promise<StoredKeypair | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openIdentityDb();
  const stored = (await idbGetIdentity(db, IDB_KEY)) as StoredKeypair | undefined;
  db.close();
  if (!stored || !stored.type) return null;
  return stored;
}

/**
 * Persistiert ein Keypair in IndexedDB.
 * CryptoKey-Objekte sind direkt in IndexedDB speicherbar (Structured Clone Algorithm).
 */
export async function saveKeypair(keys: StoredKeypair): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB nicht verfügbar');
  // Zweiter Anlaufpunkt für die Anfrage nach dauerhaftem Speicher (der erste
  // ist `verlauf/index.ts::verlaufSpeichernPflicht`). Hier entsteht die
  // Geräte-Identität — der frühestmögliche Zeitpunkt, an dem eine
  // Firefox-Nachfrage für den Nutzer einen erkennbaren Anlass hat. Wirft nie,
  // Ergebnis bewusst nicht ausgewertet.
  void dauerhaftenSpeicherAnfordern();
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
    // In-Memory-Referenz SYNCHRON vor dem await leeren (Anti-Leak-Reihenfolge):
    // signOut() ruft wipe() fire-and-forget; bliebe this.keypair bis zum IDB-
    // Delete gesetzt, läse ein Consumer in diesem Fenster noch das Keypair des
    // Vorgängers. Auch robuster: bei IDB-Fehler ist der Speicher trotzdem geleert.
    this.keypair = null;
    await wipeKeypair();
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
