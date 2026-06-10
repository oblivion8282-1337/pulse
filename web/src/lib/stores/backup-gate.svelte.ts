/**
 * Backup-Pflicht-Gate beim Self-Host-Beitritt.
 *
 * Self-Host-Server liegen NUR in der gerätelokalen `pulse.servers`-Liste und
 * werden ausschließlich über den E2E-Server-Tresor (verschlüsselt mit dem
 * Cloud-Backup-Master-Passwort) auf andere Geräte synchronisiert. Ohne ein
 * eingerichtetes Cloud-Backup gehen sie deshalb bei einem Gerätewechsel — und
 * beim Account-Switch-Cleanup, der die Liste beim Login eines anderen Users
 * leert — unwiederbringlich verloren.
 *
 * Dieser Gate stellt vor JEDEM Self-Host-Beitritt sicher, dass ein Backup
 * existiert. Fehlt es, öffnet sich ein Dialog (im Root-Layout), der das Setup
 * inline anbietet; erst danach läuft der Beitritt weiter. Cloud-Beitritte
 * brauchen das nicht und durchlaufen den Gate nie (der einzige Aufrufer ist
 * `addServerWithCertLogin`, der Cloud-Ziele nie erreicht).
 *
 * WICHTIG (Import-Zyklus): Dieses Modul importiert NICHT zurück auf
 * `add-server-flow.ts`. Es zieht nur server-vault, cert und credentials.
 */

import { serverVault } from '$lib/identity/server-vault.svelte';
import { certStore } from '$lib/identity/cert.svelte';
import { getBackup, listCerts } from '$lib/api/credentials';

class BackupGate {
  /** Steuert den BackupGateDialog im Root-Layout. */
  open = $state(false);

  /**
   * Cert-ID + Label eines bereits vorhandenen Backups auf einem ANDEREN Gerät
   * dieses Users. Sind sie gesetzt, zeigt der Gate-Dialog den Restore-Pfad
   * („du hast schon ein Backup, stell es wieder her") statt blind ein zweites
   * zu erzeugen — auch wenn früher mal „Neues Gerät" (recovery_declined)
   * geklickt wurde. Leer = echtes Erst-Setup.
   */
  restoreCertId = $state<string | null>(null);
  restoreDeviceLabel = $state<string>('');

  /** Resolver der laufenden `ensure()`-Promise; null wenn kein Dialog offen. */
  private _resolver: ((ok: boolean) => void) | null = null;

  /**
   * True, wenn ein Cloud-Backup existiert.
   *
   * Schnell-Pfad: Liegt ein Server-Tresor-Key lokal in IDB, ist garantiert
   * schon ein Backup eingerichtet (gleicher Master-Passwort-Key) → kein
   * Netzwerk-Roundtrip nötig. Sonst gegen das Backend prüfen.
   *
   * Öffentlich, damit Aufrufer (AddServerDialog) VOR dem `ensure()`-Aufruf
   * entscheiden können, ob sie ihren eigenen Dialog schließen müssen — sonst
   * läge der Backup-Setup-Dialog verwirrend über dem ihren.
   */
  async hasBackup(): Promise<boolean> {
    if (await serverVault.isUnlocked()) return true;
    const certId = certStore.cert?.claims.cert_id;
    if (!certId) return false;
    try {
      return (await getBackup(certId)) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Stellt sicher, dass ein Backup existiert. Gibt sofort `true` zurück, wenn
   * eines vorliegt; sonst öffnet sich der Dialog und die zurückgegebene Promise
   * resolvet, sobald der User das Setup abschließt (`true`) oder abbricht
   * (`false`).
   */
  async ensure(): Promise<boolean> {
    if (await this.hasBackup()) return true;
    // Hängt schon ein Dialog (paralleler ensure-Aufruf, z.B. Deep-Link + Klick
    // gleichzeitig): an dieselbe Auflösung anhängen, statt `_resolver` zu
    // überschreiben (sonst hinge der erste Aufrufer ewig).
    if (this._resolver) {
      return new Promise<boolean>((r) => {
        const prev = this._resolver!;
        this._resolver = (ok) => {
          prev(ok);
          r(ok);
        };
      });
    }
    // Hat der USER (nicht nur dieses Cert) schon irgendwo ein Backup? Dann den
    // Restore-Pfad anbieten statt eines zweiten Schlüssels.
    await this._detectExistingBackup();
    this.open = true;
    return new Promise<boolean>((r) => {
      this._resolver = r;
    });
  }

  /** Sucht ein Backup auf einem anderen Gerät desselben Users (best-effort). */
  private async _detectExistingBackup(): Promise<void> {
    this.restoreCertId = null;
    this.restoreDeviceLabel = '';
    try {
      const { devices } = await listCerts();
      const withBackup = devices.find((d) => d.has_backup);
      if (withBackup) {
        this.restoreCertId = withBackup.cert_id;
        this.restoreDeviceLabel = withBackup.device_label;
      }
    } catch {
      /* offline / Fehler → Setup-Pfad (kein Restore-Angebot) */
    }
  }

  /** Vom Dialog aufgerufen — schließt ihn und löst die wartende Promise auf. */
  resolve(ok: boolean): void {
    this.open = false;
    this.restoreCertId = null;
    this.restoreDeviceLabel = '';
    this._resolver?.(ok);
    this._resolver = null;
  }
}

export const backupGate = new BackupGate();
