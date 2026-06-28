/**
 * Vereinheitlichter Backup-Flow — "ein Account = ein Wiederherstellungs-Schlüssel".
 *
 * Alle drei Setup-Einstiege (Onboarding-Dialog, Self-Host-Backup-Gate,
 * Einstellungen → Cloud-Backup) laufen über GENAU diese zwei Funktionen:
 *
 *  - `detectBackupFlowMode()` — 'create' (Account hat noch keinen Schlüssel →
 *    erstellen) oder 'enter' (Account hat schon einen → nur eingeben; ein
 *    zweiter, abweichender Schlüssel ist nicht mehr möglich).
 *  - `setupOrUnlock(password)` — der eine Pfad: Account-Key entsperren bzw.
 *    erstmalig erzeugen (inkl. Verifikation + Migration vorhandener Legacy-
 *    Backups), DIESES Gerät unter dem AK sichern, Server-Vault aktivieren.
 *
 * Falsches Passwort wirft `WrongRecoveryKeyError` — die Formulare zeigen dann
 * einen klaren Fehler statt still einen zweiten Schlüssel anzulegen.
 *
 * NIEMALS Passwort, AK oder entschlüsselte Keypairs loggen/persistieren.
 */

import { certStore } from './cert.svelte';
import { loadKeypair } from './keypair.svelte';
import { ensureBackupCapableKeypair } from './issue-flow';
import {
  decryptKeypair,
  encryptKeypairWithAk,
  BackupDecryptError,
  type DecryptedKeypair
} from './key-backup.svelte';
import { accountKey, AccountKeyDecryptError } from './account-key.svelte';
import { createBackup, getBackup, listCerts, reconstructBlob } from '$lib/api/credentials';

export type BackupFlowMode = 'create' | 'enter';

export class WrongRecoveryKeyError extends Error {
  constructor() {
    super('wrong recovery key');
    this.name = 'WrongRecoveryKeyError';
  }
}

/**
 * 'enter', wenn der Account schon einen Schlüssel hat (Account-Key vorhanden
 * ODER irgendein Gerät hat ein Legacy-Backup) — sonst 'create'. Offline/Fehler
 * → 'create' (der Submit selbst verifiziert dann nochmal hart).
 */
export async function detectBackupFlowMode(): Promise<BackupFlowMode> {
  try {
    if (await accountKey.existsRemote()) return 'enter';
    const { devices } = await listCerts();
    if (devices.some((d) => d.has_backup)) return 'enter';
  } catch {
    /* offline o.Ä. */
  }
  return 'create';
}

/** Legacy-Backup eines anderen Geräts mit dem Passwort probe-entschlüsseln.
 *  Liefert das erste lesbare (zur Migration) — oder null, wenn keins existiert.
 *  @throws WrongRecoveryKeyError wenn Backups existieren, aber KEINS lesbar ist. */
async function probeLegacyBackups(
  password: string
): Promise<{ certId: string; label: string; keypair: DecryptedKeypair } | null> {
  const { devices } = await listCerts();
  const withBackup = devices.filter((d) => d.has_backup);
  if (withBackup.length === 0) return null;
  let sawLegacy = false;
  for (const d of withBackup) {
    const resp = await getBackup(d.cert_id);
    if (!resp) continue;
    const blob = reconstructBlob(resp);
    if (blob.v === 3) continue; // AK-Blob ohne AK-Zeile — inkonsistent, überspringen
    sawLegacy = true;
    try {
      const keypair = await decryptKeypair(blob, password);
      return { certId: d.cert_id, label: d.device_label, keypair };
    } catch (err) {
      if (err instanceof BackupDecryptError) continue; // evtl. divergenter Alt-Schlüssel
      throw err;
    }
  }
  if (sawLegacy) throw new WrongRecoveryKeyError();
  return null;
}

/**
 * Der eine Backup-Pfad: Account-Key beschaffen, dieses Gerät sichern, Vault an.
 *
 * 1. AK entsperren (vorhanden) | aus verifiziertem Legacy-Backup migrieren |
 *    frisch erzeugen (echtes Erst-Setup).
 * 2. Keypair dieses Geräts (ggf. exportierbar neu ausstellen) als v3-Blob
 *    unter dem AK sichern.
 * 3. Server-Vault: Legacy-Bestand retten, dann im AK-Modus aktivieren.
 *
 * @throws WrongRecoveryKeyError bei falschem Wiederherstellungs-Schlüssel.
 * @throws Error('NO_CERT') wenn kein aktives Cert vorliegt.
 */
export async function setupOrUnlock(password: string): Promise<void> {
  // --- 1. Account-Key beschaffen -------------------------------------------
  let ak: CryptoKey;
  if (await accountKey.existsRemote()) {
    try {
      ak = await accountKey.unlock(password);
    } catch (err) {
      if (err instanceof AccountKeyDecryptError) throw new WrongRecoveryKeyError();
      throw err;
    }
  } else {
    // Existieren Legacy-Backups, MUSS das eingegebene Passwort eins davon
    // öffnen — sonst wäre es ein zweiter Schlüssel (genau das verhindern wir).
    const legacy = await probeLegacyBackups(password);
    ak = await accountKey.create(password);
    if (legacy) {
      // Altes Geräte-Backup aufs AK-Format migrieren (best-effort).
      try {
        const v3 = await encryptKeypairWithAk(
          legacy.keypair.privateKey,
          legacy.keypair.publicKey,
          ak
        );
        await createBackup(legacy.certId, v3, legacy.label.slice(0, 64) || 'Backup');
      } catch {
        /* Legacy-Blob bleibt lesbar (decryptKeypair) — kein Datenverlust */
      }
    }
  }

  // --- 2. Dieses Gerät unter dem AK sichern --------------------------------
  let keypair = await loadKeypair();
  if (!keypair || !keypair.privateKey.extractable) {
    keypair = await ensureBackupCapableKeypair();
  }
  const certId = certStore.cert?.claims.cert_id;
  if (!certId) throw new Error('NO_CERT');
  const [privJwk, pubJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keypair.privateKey),
    crypto.subtle.exportKey('jwk', keypair.publicKey)
  ]);
  const blob = await encryptKeypairWithAk(privJwk, pubJwk, ak);
  const label = certStore.cert?.claims.device_label ?? 'Backup';
  await createBackup(certId, blob, label.slice(0, 64) || 'Backup');
}
