/**
 * Generische AES-GCM-Krypto für den Server-Vault (server-vault.svelte.ts).
 *
 * Anders als encryptKeypair/decryptKeypair in key-backup.svelte.ts (die pro
 * Aufruf Argon2id rechnen) trennen diese Helfer die Schlüssel-Ableitung von der
 * Ver-/Entschlüsselung: der AES-Key wird einmal abgeleitet (deriveKeyArgon2id),
 * gecacht und für viele Writes wiederverwendet — frischer IV pro Write.
 *
 * Argon2id-Params + Byte-Längen kommen als Single-Source aus key-backup.svelte.ts.
 */

import { BackupDecryptError, GCM_IV_BYTES, randomBytes } from './key-backup.svelte';

/** Verschlüsselt ein JSON-serialisierbares Objekt mit einem bereits abgeleiteten AES-GCM-Key. */
export async function encryptJsonWithKey(
  obj: unknown,
  aesKey: CryptoKey
): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }> {
  const iv = randomBytes(GCM_IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  return { iv, ct };
}

/**
 * Entschlüsselt ein zuvor mit encryptJsonWithKey erzeugtes Ciphertext.
 * Wirft BackupDecryptError bei falschem Key / korruptem Ciphertext.
 */
export async function decryptJsonWithKey(
  ct: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  aesKey: CryptoKey
): Promise<unknown> {
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
  } catch {
    throw new BackupDecryptError('Falscher Schlüssel oder defekter Tresor');
  }
  try {
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    throw new BackupDecryptError('Entschlüsselter Tresor-Inhalt ist kein gültiges JSON');
  }
}
