/**
 * Zero-Knowledge Backup — Argon2id + AES-GCM (v=2), PBKDF2 rückwärts-compat (v=1).
 *
 * v=2 (Standard): Argon2id (m=64 MiB, t=3, p=4) via hash-wasm → AES-256-GCM.
 * v=1 (Legacy):   PBKDF2-SHA-256 / 600 000 Iter. — bleibt lesbar, wird nicht mehr geschrieben.
 *
 * Blob-Format: KeyBackupBlob (versioniert).
 */

import { argon2id } from 'hash-wasm';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface Argon2idKdf {
  name: 'Argon2id';
  parallelism: 4;
  memory_kib: 65536;
  iterations: 3;
  /** Base64-codiertes 16-Byte-Salt. */
  salt: string;
}

export interface Pbkdf2Kdf {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: 600_000;
  /** Base64-codiertes 16-Byte-Salt. */
  salt: string;
}

export interface KeyBackupCipher {
  name: 'AES-GCM';
  /** Base64-codierter 12-Byte-IV. */
  iv: string;
  /** Base64-codierter Ciphertext inkl. 16-Byte-GCM-Tag. */
  ct: string;
}

/** Backup-Blob v=2 (Argon2id). */
export interface KeyBackupBlobV2 {
  v: 2;
  kdf: Argon2idKdf;
  cipher: KeyBackupCipher;
}

/** Backup-Blob v=1 (PBKDF2, legacy). */
export interface KeyBackupBlobV1 {
  v: 1;
  kdf: Pbkdf2Kdf;
  cipher: KeyBackupCipher;
}

/** Versionierter Backup-Blob (serialisiert als JSON-String). */
export type KeyBackupBlob = KeyBackupBlobV1 | KeyBackupBlobV2;

/** Inhalt des entschlüsselten Blobs. */
export interface DecryptedKeypair {
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
}

// ---------------------------------------------------------------------------
// Fehlertyp
// ---------------------------------------------------------------------------

export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDecryptError';
  }
}

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const SALT_BYTES = 16;
const IV_BYTES = 12;

// Argon2id-Parameter (Bitwarden-Standard)
const A2_PARALLELISM = 4;
const A2_MEMORY_KIB = 65536; // 64 MiB
const A2_ITERATIONS = 3;

// PBKDF2-Legacy
const PBKDF2_ITERATIONS = 600_000;

// ---------------------------------------------------------------------------
// Interne Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Erzeugt n kryptografisch sichere Zufallsbytes.
 * `.slice()` stellt einen echten ArrayBuffer ohne SharedArrayBuffer-Risiko sicher.
 */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf.slice() as Uint8Array<ArrayBuffer>;
}

/** Uint8Array/ArrayBuffer → Base64 (standard). */
function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...u8));
}

/** Base64 → Uint8Array<ArrayBuffer>. */
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes as Uint8Array<ArrayBuffer>;
}

/** Argon2id → AES-256-GCM-CryptoKey. */
async function deriveKeyArgon2id(
  password: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const hashRaw = await argon2id({
    password,
    salt,
    parallelism: A2_PARALLELISM,
    memorySize: A2_MEMORY_KIB,
    iterations: A2_ITERATIONS,
    hashLength: 32,
    outputType: 'binary'
  });
  // .slice() erzeugt Uint8Array<ArrayBuffer> (kein SharedArrayBuffer-Risiko)
  const hash = (hashRaw as Uint8Array).slice() as Uint8Array<ArrayBuffer>;
  return crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** PBKDF2-SHA-256 → AES-256-GCM-CryptoKey (legacy, v=1). */
async function deriveKeyPbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Verschlüsselt ein Ed25519-Keypair als JWK-Pair mit einem Master-Passwort.
 *
 * Schreibt immer v=2 (Argon2id):
 *   1. 16-Byte-Salt + 12-Byte-IV aus crypto.getRandomValues()
 *   2. Argon2id (m=64 MiB, t=3, p=4) → 32-Byte-Key → AES-256-GCM-Key
 *   3. Plaintext = JSON.stringify({privateKey, publicKey})
 *   4. AES-GCM-Encrypt → Ciphertext (inkl. 16-Byte-Tag)
 *   5. Alles Base64-codiert in KeyBackupBlobV2 verpackt
 *
 * @param privateKeyJwk  - Privater Schlüssel als JWK (muss extractable gewesen sein)
 * @param publicKeyJwk   - Öffentlicher Schlüssel als JWK
 * @param masterPassword - Master-Passwort des Users
 * @returns KeyBackupBlobV2 (JSON-serialisierbar)
 */
export async function encryptKeypair(
  privateKeyJwk: JsonWebKey,
  publicKeyJwk: JsonWebKey,
  masterPassword: string
): Promise<KeyBackupBlobV2> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  const aesKey = await deriveKeyArgon2id(masterPassword, salt);

  const plaintext = new TextEncoder().encode(
    JSON.stringify({ privateKey: privateKeyJwk, publicKey: publicKeyJwk })
  );

  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);

  return {
    v: 2,
    kdf: {
      name: 'Argon2id',
      parallelism: A2_PARALLELISM,
      memory_kib: A2_MEMORY_KIB,
      iterations: A2_ITERATIONS,
      salt: toBase64(salt)
    },
    cipher: {
      name: 'AES-GCM',
      iv: toBase64(iv),
      ct: toBase64(cipherBuf)
    }
  };
}

/**
 * Entschlüsselt einen KeyBackupBlob mit dem Master-Passwort.
 *
 * Dispatcht auf KDF-Version:
 *   v=2 → Argon2id
 *   v=1 → PBKDF2-SHA-256 (legacy, backwards-compat)
 *
 * Wirft BackupDecryptError wenn:
 *   - das Passwort falsch ist (AES-GCM-Tag-Verifikation schlägt fehl)
 *   - der Blob korrupt/manipuliert ist
 *   - die Blob-Version unbekannt ist
 *
 * @param blob           - Zuvor erzeugter KeyBackupBlob (v=1 oder v=2)
 * @param masterPassword - Master-Passwort des Users
 * @returns DecryptedKeypair mit {privateKey, publicKey} als JWK
 */
export async function decryptKeypair(
  blob: KeyBackupBlob,
  masterPassword: string
): Promise<DecryptedKeypair> {
  const salt = fromBase64(blob.kdf.salt);
  const iv = fromBase64(blob.cipher.iv);
  const ct = fromBase64(blob.cipher.ct);

  let aesKey: CryptoKey;
  if (blob.v === 2) {
    aesKey = await deriveKeyArgon2id(masterPassword, salt);
  } else if (blob.v === 1) {
    aesKey = await deriveKeyPbkdf2(masterPassword, salt);
  } else {
    // TypeScript-Erschöpfungs-Guard für zukünftige Versionen
    throw new BackupDecryptError(`Unbekannte Blob-Version: ${(blob as { v: number }).v}`);
  }

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
  } catch {
    // AES-GCM wirft OperationError bei falschem Passwort oder korruptem Ciphertext
    throw new BackupDecryptError('Falsches Master-Passwort oder defektes Backup');
  }

  let parsed: DecryptedKeypair;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plainBuf)) as DecryptedKeypair;
  } catch {
    throw new BackupDecryptError('Entschlüsselter Inhalt ist kein gültiges JSON');
  }

  if (!parsed.privateKey || !parsed.publicKey) {
    throw new BackupDecryptError('Entschlüsselter Blob enthält kein vollständiges Keypair');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Svelte-5-Runes-State (Backup-Status, kein persistenter State nötig)
// ---------------------------------------------------------------------------

class KeyBackupState {
  /** Gibt an ob gerade ein Backup-Vorgang läuft. */
  encrypting = $state(false);
  decrypting = $state(false);
  lastError = $state<string | null>(null);

  async encrypt(
    privateKeyJwk: JsonWebKey,
    publicKeyJwk: JsonWebKey,
    masterPassword: string
  ): Promise<KeyBackupBlobV2> {
    this.encrypting = true;
    this.lastError = null;
    try {
      return await encryptKeypair(privateKeyJwk, publicKeyJwk, masterPassword);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.encrypting = false;
    }
  }

  async decrypt(blob: KeyBackupBlob, masterPassword: string): Promise<DecryptedKeypair> {
    this.decrypting = true;
    this.lastError = null;
    try {
      return await decryptKeypair(blob, masterPassword);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.decrypting = false;
    }
  }
}

export const keyBackupState = new KeyBackupState();
