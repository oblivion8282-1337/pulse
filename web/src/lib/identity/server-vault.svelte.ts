/**
 * Zero-Knowledge E2E-Sync der Self-Host-Server-Liste ("Server-Tresor").
 *
 * Problem: `pulse.servers` ist rein gerätelokaler localStorage-State und wird
 * nirgends mit dem Account synchronisiert — neues Gerät / geleerter Storage →
 * Server-Liste weg, ohne Restore (siehe servers.svelte.ts).
 *
 * Lösung: Die Liste der Self-Host-Server wird **auf dem Gerät** verschlüsselt
 * (Argon2id → AES-256-GCM, Krypto aus key-backup.svelte.ts) und als opaker
 * Blob server-seitig abgelegt (`/server-vault`). Die Cloud sieht nur
 * Chiffretext — nie, welchen Instanzen der User beigetreten ist.
 *
 * Schlüssel = derselbe Master-Passwort-abgeleitete AES-Key wie das
 * Identitäts-Cloud-Backup (Unified-Password-Design). Der abgeleitete Key wird
 * **non-extractable in IndexedDB** gehalten (`pulse.vault-key`): überlebt
 * Sessions (Push ohne erneute Passwort-Abfrage), kann via JS nie exportiert
 * werden (XSS-Schutz), und wird bei signOut gewischt.
 *
 * Flows:
 *  - `unlock(password)`  — bei Backup-Setup ODER Recover: Key ableiten, Tresor
 *    holen+mergen (falls vorhanden) bzw. neu anlegen, dann pushen.
 *  - `pullIfUnlocked()`  — beim Hydrate auf bekanntem Gerät: Key liegt in IDB →
 *    Tresor holen + mergen, ohne Passwort.
 *  - `schedulePush()`    — debounced bei jeder pulse.servers-Änderung.
 *  - `wipe()`            — signOut: Memory + IDB-Key löschen.
 */

import {
  deriveKeyArgon2id,
  randomBytes,
  toBase64,
  fromBase64,
  ARGON2ID_KDF_PARAMS,
  KDF_SALT_BYTES
} from './key-backup.svelte';
import { encryptJsonWithKey, decryptJsonWithKey } from './vault-crypto';
import { openIdentityDb, idbGetIdentity, idbPutIdentity, STORE_NAME } from './idb-shared';
import { serversStore, type ServerEntry } from '$lib/api/servers.svelte';
import { getServerVault, putServerVault } from '$lib/api/server-vault';

const IDB_KEY = 'pulse.vault-key';
const PUSH_DEBOUNCE_MS = 1500;

/** In IndexedDB persistierte Form. `key` ist non-extractable. */
interface StoredVaultKey {
  key: CryptoKey;
  salt: string; // base64
}

/** Pro Self-Host-Server gesyncte Felder (Cloud wird nie gesynct — auto-angelegt). */
interface VaultServerEntry {
  hostname: string;
  label: string;
  instance_id: string | null;
  pairwise_sub: string | null;
}

function idbDeleteIdentity(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

class ServerVault {
  /** Gecachter Key + Salt für die laufende Session. null = noch nicht geladen/gesetzt. */
  private cached: StoredVaultKey | null = null;
  private _attached = false;
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Unterdrückt Push während ein Remote-Merge läuft (verhindert Push-Schleife). */
  private _applyingRemote = false;

  /** Lädt den persistierten Key aus IDB in den Memory-Cache (idempotent). */
  private async loadCached(): Promise<StoredVaultKey | null> {
    if (this.cached) return this.cached;
    if (typeof window === 'undefined') return null;
    try {
      const db = await openIdentityDb();
      const stored = (await idbGetIdentity(db, IDB_KEY)) as StoredVaultKey | undefined;
      if (stored?.key) this.cached = stored;
    } catch {
      /* IDB nicht verfügbar (Private-Browsing etc.) — Sync degradiert still */
    }
    return this.cached;
  }

  private async persistCached(value: StoredVaultKey): Promise<void> {
    this.cached = value;
    try {
      const db = await openIdentityDb();
      await idbPutIdentity(db, IDB_KEY, value);
    } catch {
      /* best-effort — Memory-Cache bleibt für die Session gültig */
    }
  }

  /** True wenn ein Tresor-Key verfügbar ist (Memory oder IDB). */
  async isUnlocked(): Promise<boolean> {
    return (await this.loadCached()) !== null;
  }

  /**
   * Registriert den Debounced-Push-Listener am serversStore. Einmal beim
   * App-Start aufrufen (nach serversStore.init()).
   */
  attach(): void {
    if (this._attached) return;
    this._attached = true;
    serversStore.setChangeListener(() => {
      if (this._applyingRemote) return;
      this.schedulePush();
    });
  }

  /** Debounced Push (coalesct schnelle Folgeänderungen). */
  schedulePush(): void {
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      void this.pushNow();
    }, PUSH_DEBOUNCE_MS);
  }

  /** Verschlüsselt die aktuelle Self-Host-Server-Liste und legt sie im Tresor ab. */
  async pushNow(): Promise<void> {
    const cached = await this.loadCached();
    if (!cached) return; // Sync nicht aktiviert → no-op
    const entries: VaultServerEntry[] = serversStore.servers
      .filter((s) => !s.isCloud)
      .map((s) => ({
        hostname: s.hostname,
        label: s.label,
        instance_id: s.instance_id,
        pairwise_sub: s.pairwise_sub
      }));
    try {
      const { iv, ct } = await encryptJsonWithKey(entries, cached.key);
      await putServerVault({
        encrypted_blob: toBase64(ct),
        kdf_salt: cached.salt,
        kdf_params: JSON.stringify(ARGON2ID_KDF_PARAMS),
        gcm_nonce: toBase64(iv)
      });
    } catch {
      /* Netzwerk-Blip o.Ä. — nächste Änderung pusht erneut */
    }
  }

  /** Merged eine entschlüsselte Server-Liste in den serversStore (dedupe per Hostname). */
  private mergeIntoStore(entries: VaultServerEntry[]): boolean {
    let changed = false;
    this._applyingRemote = true;
    try {
      for (const e of entries) {
        if (!e?.hostname) continue;
        if (serversStore.findByHostname(e.hostname)) continue;
        serversStore.add(
          e.hostname,
          e.label,
          e.instance_id ?? undefined,
          e.pairwise_sub ?? undefined
        );
        changed = true;
      }
    } finally {
      this._applyingRemote = false;
    }
    return changed;
  }

  /** Holt + entschlüsselt den Tresor mit dem gegebenen Key und merged ihn. */
  private async pullWithKey(key: CryptoKey): Promise<boolean> {
    const remote = await getServerVault();
    if (!remote) return false;
    const ct = fromBase64(remote.encrypted_blob);
    const iv = fromBase64(remote.gcm_nonce);
    const list = (await decryptJsonWithKey(ct, iv, key)) as VaultServerEntry[];
    if (!Array.isArray(list)) return false;
    return this.mergeIntoStore(list);
  }

  /** Versucht, den Remote-Tresor mit `key` zu lesen + zu mergen. Schluckt Fehler. */
  private async tryMergeRemote(
    remote: { encrypted_blob: string; gcm_nonce: string },
    key: CryptoKey
  ): Promise<void> {
    try {
      const list = (await decryptJsonWithKey(
        fromBase64(remote.encrypted_blob),
        fromBase64(remote.gcm_nonce),
        key
      )) as VaultServerEntry[];
      if (Array.isArray(list)) this.mergeIntoStore(list);
    } catch {
      /* nicht lesbar (z.B. mit anderem Passwort verschlüsselt) — best-effort */
    }
  }

  /**
   * Sync **aktivieren oder re-keyen** mit dem Master-Passwort. Aufgerufen vom
   * Backup-**Setup/Update** + Onboarding. Re-keyt aus der **lokalen Liste** als
   * Wahrheit → kann den User nie aussperren und überlebt einen Master-Passwort-
   * Wechsel (anders als ein decrypt-then-throw). Existiert schon ein Remote-
   * Tresor, wird er per altem Cache-Key best-effort gemergt (rettet Server, die
   * nur auf anderen Geräten lagen), bevor mit frischem Salt re-verschlüsselt wird.
   */
  async unlockForSetup(password: string): Promise<void> {
    const remote = await getServerVault();
    if (remote) {
      const old = await this.loadCached();
      if (old) await this.tryMergeRemote(remote, old.key);
    }
    // Frisches Salt → Key aus (neuem) Passwort ableiten, lokale Liste hochschieben.
    const salt = randomBytes(KDF_SALT_BYTES);
    const key = await deriveKeyArgon2id(password, salt);
    await this.persistCached({ key, salt: toBase64(salt) });
    await this.pushNow();
  }

  /**
   * Sync **wiederherstellen** mit dem Master-Passwort (Recover-Flow, evtl. neues
   * Gerät). Leitet den Key aus Passwort + dem Salt des Remote-Tresors ab,
   * entschlüsselt + merged. **Falsches Passwort → wirft `VAULT_DECRYPT_FAILED`,
   * ohne den Remote-Tresor anzutasten** (kein Datenverlust durch Tippfehler).
   */
  async unlockForRestore(password: string): Promise<void> {
    const remote = await getServerVault();
    if (!remote) {
      // Kein Remote-Tresor → für die Zukunft aus der lokalen Liste anlegen.
      await this.unlockForSetup(password);
      return;
    }
    const salt = fromBase64(remote.kdf_salt);
    const key = await deriveKeyArgon2id(password, salt);
    let list: VaultServerEntry[];
    try {
      list = (await decryptJsonWithKey(
        fromBase64(remote.encrypted_blob),
        fromBase64(remote.gcm_nonce),
        key
      )) as VaultServerEntry[];
    } catch {
      // Falsches Passwort — Remote-Tresor NICHT überschreiben, Key NICHT cachen.
      throw new Error('VAULT_DECRYPT_FAILED');
    }
    await this.persistCached({ key, salt: toBase64(salt) });
    if (Array.isArray(list)) this.mergeIntoStore(list);
    await this.pushNow();
  }

  /**
   * Beim Hydrate auf bekanntem Gerät: liegt ein Key in IDB, Tresor holen +
   * mergen — ohne Passwort. Best-effort.
   */
  async pullIfUnlocked(): Promise<void> {
    const cached = await this.loadCached();
    if (!cached) return;
    try {
      await this.pullWithKey(cached.key);
    } catch {
      /* still — z.B. Tresor mit neuem Passwort re-verschlüsselt; Recover-Flow heilt */
    }
  }

  /** signOut: Memory + IDB-Key löschen. */
  async wipe(): Promise<void> {
    this.cached = null;
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
    try {
      const db = await openIdentityDb();
      await idbDeleteIdentity(db, IDB_KEY);
    } catch {
      /* ignore */
    }
  }
}

export const serverVault = new ServerVault();

// Re-Export des Stores, den dieses Modul tatsächlich nutzt — Consumer/Tests, die
// den Vault treiben, greifen so garantiert auf dieselbe serversStore-Instanz zu
// (kein Modul-Instanz-Mismatch über unterschiedliche Import-Specifier).
export { serversStore };
export type { ServerEntry };
