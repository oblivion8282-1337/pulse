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

/** KDF-Marker v=3: kein KDF — direkt mit dem Account-Key verschlüsselt. */
export interface AccountKeyKdf {
  name: 'AccountKey';
}

/** Backup-Blob v=3 (Account-Key, Envelope-Encryption). */
export interface KeyBackupBlobV3 {
  v: 3;
  kdf: AccountKeyKdf;
  cipher: KeyBackupCipher;
}

/** Versionierter Backup-Blob (serialisiert als JSON-String). */
export type KeyBackupBlob = KeyBackupBlobV1 | KeyBackupBlobV2 | KeyBackupBlobV3;

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

export const KDF_SALT_BYTES = 16;
export const GCM_IV_BYTES = 12;

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
export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf.slice() as Uint8Array<ArrayBuffer>;
}

/** Uint8Array/ArrayBuffer → Base64 (standard). */
export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(Array.from(u8, b => String.fromCharCode(b)).join(''));
}

/** Base64 → Uint8Array<ArrayBuffer>. */
export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes as Uint8Array<ArrayBuffer>;
}

/** Alphabet für generierte Wiederherstellungs-Schlüssel: 30 Zeichen ohne die
 *  optisch verwechselbaren I, L, O, U, 0, 1 — fürs fehlerfreie Abschreiben. */
const RECOVERY_KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * Erzeugt einen starken, gut lesbaren Wiederherstellungs-Schlüssel als Master-
 * Passwort-Ersatz (Generator-Modus im Backup-Setup). Standard: 5 Gruppen à 5
 * Zeichen (`XXXXX-XXXXX-…`) = 25 Zeichen aus einem 30er-Alphabet ≈ 122 Bit
 * Entropie — weit über der 12-Zeichen-Mindestlänge. Der Bindestrich-getrennte
 * String IST der Schlüssel (wird 1:1 als Passwort abgeleitet); Kopieren/Download
 * liefern ihn exakt, sodass die Wiederherstellung per Einfügen funktioniert.
 *
 * Rejection-Sampling (`< max`) verhindert den Modulo-Bias, den ein simples
 * `byte % 30` einführen würde.
 */
export function generateRecoveryKey(groups = 5, groupLen = 5): string {
  const alphabetLen = RECOVERY_KEY_ALPHABET.length;
  const max = Math.floor(256 / alphabetLen) * alphabetLen; // 240 — Bias-Schutz
  const total = groups * groupLen;
  const chars: string[] = [];
  while (chars.length < total) {
    const buf = randomBytes(total);
    for (let i = 0; i < buf.length && chars.length < total; i++) {
      if (buf[i] < max) chars.push(RECOVERY_KEY_ALPHABET[buf[i] % alphabetLen]);
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < total; i += groupLen) parts.push(chars.slice(i, i + groupLen).join(''));
  return parts.join('-');
}

/** Argon2id → AES-256-GCM-CryptoKey. */
export async function deriveKeyArgon2id(
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
  const key = await crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  // Abgeleiteten Roh-Key nach dem Import nullen (Heap-Hygiene).
  hash.fill(0);
  (hashRaw as Uint8Array).fill(0);
  return key;
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
  const salt = randomBytes(KDF_SALT_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);

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
 * Verschlüsselt ein Keypair direkt mit dem Account-Key (Blob v=3).
 * Kein KDF — der AK ist bereits ein AES-256-GCM-Key.
 */
export async function encryptKeypairWithAk(
  privateKeyJwk: JsonWebKey,
  publicKeyJwk: JsonWebKey,
  ak: CryptoKey
): Promise<KeyBackupBlobV3> {
  const iv = randomBytes(GCM_IV_BYTES);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ privateKey: privateKeyJwk, publicKey: publicKeyJwk })
  );
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ak, plaintext);
  return {
    v: 3,
    kdf: { name: 'AccountKey' },
    cipher: { name: 'AES-GCM', iv: toBase64(iv), ct: toBase64(cipherBuf) }
  };
}

/** Entschlüsselt einen v=3-Blob mit dem Account-Key. */
export async function decryptKeypairWithAk(
  blob: KeyBackupBlobV3,
  ak: CryptoKey
): Promise<DecryptedKeypair> {
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(blob.cipher.iv) },
      ak,
      fromBase64(blob.cipher.ct)
    );
  } catch {
    throw new BackupDecryptError('Falscher Account-Key oder defektes Backup');
  }
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf)) as DecryptedKeypair;
  if (!parsed.privateKey || !parsed.publicKey) {
    throw new BackupDecryptError('Entschlüsselter Blob enthält kein vollständiges Keypair');
  }
  return parsed;
}

/**
 * Entschlüsselt einen passwort-basierten KeyBackupBlob mit dem Master-Passwort.
 *
 * Dispatcht auf KDF-Version:
 *   v=2 → Argon2id
 *   v=1 → PBKDF2-SHA-256 (legacy, backwards-compat)
 *   v=3 → NICHT hier — braucht den Account-Key (decryptKeypairWithAk)
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
  if (blob.v === 3) {
    throw new BackupDecryptError('v3-Backup braucht den Account-Key (decryptKeypairWithAk)');
  }
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
// Vault-Krypto-Parameter (Single-Source) — die generischen encryptJsonWithKey/
// Vault-Drop (siehe Migrations-Historie): diese Helfer sind obsolet.
// Argon2id-Params identisch zum Keypair-Backup (v=2).
// ---------------------------------------------------------------------------

/** Argon2id-Parameter als serialisierbares Objekt (für vault kdf_params). */
export const ARGON2ID_KDF_PARAMS = {
  name: 'Argon2id' as const,
  parallelism: A2_PARALLELISM,
  memory_kib: A2_MEMORY_KIB,
  iterations: A2_ITERATIONS
};

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
