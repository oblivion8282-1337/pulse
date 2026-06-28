/**
 * Backup-Pflicht-Gate beim Self-Host-Beitritt.
 *
 * Prüft vor jedem Self-Host-Beitritt, ob ein Cloud-Backup existiert.
 * Früher (= vor Vault-Drop) war das Pflicht, weil der Zero-Knowledge-Server-
 * Tresor die Server-Liste nur lokal hielt und ohne Backup auf anderen Geräten
 * verloren ging. Jetzt ist die Server-Liste serverseitig (Account-basiert),
 * dieser Gate bleibt nur für User übrig, die zusätzlich ein optionales
 * Cloud-Backup für ihre Identitäts-Daten einrichten wollen.
 *
 * WICHTIG (Import-Zyklus): Dieses Modul importiert NICHT zurück auf
 * `add-server-flow.ts`. Es zieht nur cert und credentials.
 */

import { certStore } from '$lib/identity/cert.svelte';
import { getBackup } from '$lib/api/credentials';

class BackupGate {
  /** Steuert den BackupGateDialog im Root-Layout. */
  open = $state(false);

  /** Resolver der laufenden `ensure()`-Promise; null wenn kein Dialog offen. */
  private _resolver: ((ok: boolean) => void) | null = null;
  /** Die laufende Gate-Promise — von ALLEN parallelen `ensure()`-Aufrufern
   *  geteilt, damit kein Aufrufer hängt. Atomar zusammen mit `_resolver` in
   *  `resolve()` geleert. */
  private _gatePromise: Promise<boolean> | null = null;

  /**
   * True, wenn ein Cloud-Backup existiert.
   *
   * Öffentlich, damit Aufrufer (AddServerDialog) VOR dem `ensure()`-Aufruf
   * entscheiden können, ob sie ihren eigenen Dialog schließen müssen — sonst
   * läge der Backup-Setup-Dialog verwirrend über dem ihren.
   */
  async hasBackup(): Promise<boolean> {
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
    // Läuft schon ein Gate (paralleler ensure-Aufruf, z.B. Deep-Link + Klick
    // gleichzeitig): DIESELBE Promise zurückgeben statt `_resolver` zu chainen.
    // Die frühere Chain-Logik hatte ein Race: feuerte `resolve()` zwischen dem
    // `await hasBackup()` und diesem Check, sah der zweite Aufrufer `_resolver
    // === null`, öffnete den Dialog erneut und hing ewig.
    if (this._gatePromise) return this._gatePromise;
    this.open = true;
    this._gatePromise = new Promise<boolean>((r) => {
      this._resolver = r;
    });
    return this._gatePromise;
  }

  /** Vom Dialog aufgerufen — schließt ihn und löst die wartende Promise auf. */
  resolve(ok: boolean): void {
    this.open = false;
    this._resolver?.(ok);
    this._resolver = null;
    this._gatePromise = null;
  }
}

export const backupGate = new BackupGate();
