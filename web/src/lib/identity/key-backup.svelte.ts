/**
 * Zero-Knowledge Backup — PBKDF2-SHA-256 + AES-GCM (Block 2.B).
 *
 * Verschlüsselt ein Ed25519-Keypair (als JWK-Pair) mit einem Master-Passwort.
 * WebCrypto only — keine externen Abhängigkeiten.
 *
 * KDF-Wahl: PBKDF2-SHA-256 mit 600 000 Iterationen (OWASP 2026).
 *   Argon2id wäre stärker, ist aber in WebCrypto nicht nativ verfügbar.
 *   Ein Wechsel wäre möglich sobald eine Browser-native API existiert oder
 *   argon2-browser als WASM-Dep akzeptiert wird (BACKUP_NOTES.md).
 *
 * Blob-Format: KeyBackupBlob (versioniert, v:1).
 */

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface KeyBackupKdf {
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

/** Versionierter Backup-Blob (serialisiert als JSON-String). */
export interface KeyBackupBlob {
  v: 1;
  kdf: KeyBackupKdf;
  cipher: KeyBackupCipher;
}

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

const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// Interne Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Erzeugt n kryptografisch sichere Zufallsbytes als Uint8Array<ArrayBuffer>.
 * `crypto.getRandomValues()` gibt `Uint8Array<ArrayBufferLike>` zurück — durch
 * `.slice()` wird ein echter `ArrayBuffer` ohne SharedArrayBuffer-Risiko erzeugt.
 */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf.slice() as Uint8Array<ArrayBuffer>;
}

/** Uint8Array → Base64 (standard, nicht URL-safe). */
function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
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

/**
 * Leitet einen AES-256-GCM-Key aus Passwort + Salt via PBKDF2 ab.
 * Gibt den rohen CryptoKey zurück.
 */
async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: KDF_ITERATIONS
    },
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
 * Vorgehen:
 *   1. 16-Byte-Salt + 12-Byte-IV aus crypto.getRandomValues()
 *   2. PBKDF2-SHA-256 (600k Iter.) → AES-256-GCM-Key
 *   3. Plaintext = JSON.stringify({privateKey, publicKey})
 *   4. AES-GCM-Encrypt → Ciphertext (inkl. 16-Byte-Tag)
 *   5. Alles Base64-codiert in KeyBackupBlob verpackt
 *
 * @param privateKeyJwk - Privater Schlüssel als JWK (muss extractable gewesen sein)
 * @param publicKeyJwk  - Öffentlicher Schlüssel als JWK
 * @param masterPassword - Master-Passwort des Users
 * @returns KeyBackupBlob (JSON-serialisierbar)
 */
export async function encryptKeypair(
  privateKeyJwk: JsonWebKey,
  publicKeyJwk: JsonWebKey,
  masterPassword: string
): Promise<KeyBackupBlob> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  const aesKey = await deriveKey(masterPassword, salt);

  const plaintext = new TextEncoder().encode(
    JSON.stringify({ privateKey: privateKeyJwk, publicKey: publicKeyJwk })
  );

  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);

  return {
    v: 1,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: KDF_ITERATIONS,
      salt: toBase64(salt.buffer)
    },
    cipher: {
      name: 'AES-GCM',
      iv: toBase64(iv.buffer),
      ct: toBase64(cipherBuf)
    }
  };
}

/**
 * Entschlüsselt einen KeyBackupBlob mit dem Master-Passwort.
 *
 * Wirft BackupDecryptError wenn:
 *   - das Passwort falsch ist (AES-GCM-Tag-Verifikation schlägt fehl)
 *   - der Blob korrupt/manipuliert ist
 *
 * @param blob           - Zuvor erzeugter KeyBackupBlob
 * @param masterPassword - Master-Passwort des Users
 * @returns DecryptedKeypair mit {privateKey, publicKey} als JWK
 */
export async function decryptKeypair(
  blob: KeyBackupBlob,
  masterPassword: string
): Promise<DecryptedKeypair> {
  if (blob.v !== 1) {
    throw new BackupDecryptError(`Unbekannte Blob-Version: ${blob.v}`);
  }

  const salt = fromBase64(blob.kdf.salt);
  const iv = fromBase64(blob.cipher.iv);
  const ct = fromBase64(blob.cipher.ct);

  const aesKey = await deriveKey(masterPassword, salt);

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
  ): Promise<KeyBackupBlob> {
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
