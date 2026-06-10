/**
 * Account-Key (AK) — Envelope-Encryption-Kern des "ein Account = ein
 * Wiederherstellungs-Schlüssel"-Modells.
 *
 * Der AK ist ein zufälliger 256-bit-AES-GCM-Schlüssel, der ALLES Weitere
 * verschlüsselt (Geräte-Key-Backups v3, Server-Vault v2). Das Master-Passwort
 * wickelt nur den AK ein (`wrapped_key` in der Cloud). Dadurch:
 *  - kann es strukturell nur EIN gültiges Master-Passwort pro Account geben
 *    (es gibt nur ein Ding, das es öffnet),
 *  - wird Passwort-Wechsel trivial (nur re-wrap, alle Blobs bleiben),
 *  - bleibt alles Zero-Knowledge (Cloud sieht nur Chiffretext).
 *
 * Lokal wird der entsperrte AK wie der Vault-Key **non-extractable in
 * IndexedDB** gehalten (`pulse.account-key`): überlebt Sessions, via JS nie
 * exportierbar (XSS-Schutz), wird bei signOut gewischt.
 *
 * NIEMALS Passwort oder rohe AK-Bytes loggen/persistieren.
 */

import {
  deriveKeyArgon2id,
  randomBytes,
  toBase64,
  fromBase64,
  ARGON2ID_KDF_PARAMS,
  KDF_SALT_BYTES,
  GCM_IV_BYTES
} from './key-backup.svelte';
import { openIdentityDb, idbGetIdentity, idbPutIdentity, STORE_NAME } from './idb-shared';
import { getAccountKey as apiGet, putAccountKey as apiPut } from '$lib/api/account-key';

const IDB_KEY = 'pulse.account-key';

export class AccountKeyDecryptError extends Error {
  constructor() {
    super('wrong recovery key');
    this.name = 'AccountKeyDecryptError';
  }
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Importiert rohe AK-Bytes als non-extractable AES-GCM-Key und nullt den Puffer. */
async function importAk(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  raw.fill(0);
  return key;
}

class AccountKeyStore {
  private cached: CryptoKey | null = null;

  /** Entsperrter AK aus Memory/IDB — null wenn dieses Gerät ihn nicht hat. */
  async getCached(): Promise<CryptoKey | null> {
    if (this.cached) return this.cached;
    if (typeof window === 'undefined') return null;
    try {
      const db = await openIdentityDb();
      const stored = (await idbGetIdentity(db, IDB_KEY)) as CryptoKey | undefined;
      if (stored) this.cached = stored;
    } catch {
      /* IDB nicht verfügbar — degradiert still */
    }
    return this.cached;
  }

  /** True, wenn der Account bereits einen (gewrappten) AK in der Cloud hat. */
  async existsRemote(): Promise<boolean> {
    return (await apiGet()) !== null;
  }

  /**
   * Entsperrt den vorhandenen AK mit dem Master-Passwort.
   * @throws AccountKeyDecryptError bei falschem Passwort.
   * @throws Error('NO_ACCOUNT_KEY') wenn der Account noch keinen AK hat.
   */
  async unlock(password: string): Promise<CryptoKey> {
    const remote = await apiGet();
    if (!remote) throw new Error('NO_ACCOUNT_KEY');
    const kek = await deriveKeyArgon2id(password, fromBase64(remote.kdf_salt));
    let rawBuf: ArrayBuffer;
    try {
      rawBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(remote.gcm_nonce) },
        kek,
        fromBase64(remote.wrapped_key)
      );
    } catch {
      throw new AccountKeyDecryptError();
    }
    const ak = await importAk(new Uint8Array(rawBuf).slice() as Uint8Array<ArrayBuffer>);
    new Uint8Array(rawBuf).fill(0);
    await this.persist(ak);
    return ak;
  }

  /**
   * Erzeugt einen frischen AK, wrappt ihn mit dem Passwort und legt ihn in der
   * Cloud ab. NUR für den Erst-Setup — existiert schon einer, antwortet das
   * Backend 409 (Schutz vor versehentlichem Überschreiben).
   */
  async create(password: string): Promise<CryptoKey> {
    const raw = randomBytes(32);
    const salt = randomBytes(KDF_SALT_BYTES);
    const iv = randomBytes(GCM_IV_BYTES);
    const kek = await deriveKeyArgon2id(password, salt);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
    await apiPut({
      wrapped_key: toBase64(wrapped),
      kdf_salt: toBase64(salt),
      kdf_params: JSON.stringify(ARGON2ID_KDF_PARAMS),
      gcm_nonce: toBase64(iv)
    });
    const ak = await importAk(raw);
    await this.persist(ak);
    return ak;
  }

  private async persist(key: CryptoKey): Promise<void> {
    this.cached = key;
    try {
      const db = await openIdentityDb();
      await idbPutIdentity(db, IDB_KEY, key);
    } catch {
      /* best-effort — Memory-Cache bleibt für die Session */
    }
  }

  /** signOut: Memory + IDB löschen. */
  async wipe(): Promise<void> {
    this.cached = null;
    try {
      const db = await openIdentityDb();
      await idbDelete(db, IDB_KEY);
    } catch {
      /* ignore */
    }
  }
}

export const accountKey = new AccountKeyStore();
