/**
 * Pending-Self-Host-Anträge — Cloud-Admin-Benachrichtigung.
 *
 * Problem: `POST /me/instance-applications` legt nur eine DB-Zeile an — kein
 * Push, keine Mail. Ein Cloud-Admin merkt einen neuen Antrag nur, wenn er
 * zufällig ins Admin-Panel schaut. Dieser Store pollt periodisch den
 * Pending-Zähler und macht ihn reaktiv (Badge in `UserFooter`) + toastet bei
 * Zuwachs während einer Session.
 *
 * Nur **Cloud-Admins** pollen (`auth.user.is_admin`). Nicht-Admins lösen nie
 * einen Request aus; der Endpoint ist server-seitig zusätzlich cloud-gegated
 * (`_require_cloud`) und admin-gegated.
 *
 * Toast-Logik: `pulse.instanceApps.lastSeen` (localStorage) merkt den zuletzt
 * quittierten Stand. Erste Messung einer Installation → still als Baseline
 * (kein Toast-Schwall beim ersten Admin-Login mit Alt-Anträgen). Danach
 * toastet jeder Stand `> lastSeen`. Das Badge zeigt den Stand immer an,
 * unabhängig vom Toast.
 */

import { adminInstancesApi } from '$lib/api/instances';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 60_000;
const LS_LAST_SEEN = 'pulse.instanceApps.lastSeen';

class PendingInstanceApps {
  /** Anzahl offener (pending) Anträge. 0 für Nicht-Admins. */
  count = $state(0);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  /** Startet den Poll (idempotent). Initialer Poll sofort, dann alle 60 s. */
  start(): void {
    if (this._running || typeof window === 'undefined') return;
    this._running = true;
    void this._poll();
    this._timer = setInterval(() => void this._poll(), POLL_MS);
  }

  /** Sofort neu laden — vom `admin_application_pending`-WS-Ereignis gerufen,
   *  damit der Admin nicht bis zum nächsten Poll-Tick warten muss. */
  refresh(): void {
    void this._poll();
  }

  /** Stoppt den Poll (Sign-Out / Layout-Destroy). */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    // Zähler zurücksetzen, damit nach Sign-Out + Re-Login (anderer User) kein
    // veralteter Badge-Stand kurz aufblitzt, bevor der erste Poll greift.
    this.count = 0;
  }

  private _lastSeen(): number {
    const raw = window.localStorage.getItem(LS_LAST_SEEN);
    if (raw === null) return -1; // -1 = noch keine Baseline
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }

  private _setLastSeen(n: number): void {
    window.localStorage.setItem(LS_LAST_SEEN, String(n));
  }

  private async _poll(): Promise<void> {
    // Nur Cloud-Admins pollen — sonst 403/irrelevant.
    if (!auth.user?.is_admin) {
      this.count = 0;
      return;
    }
    let apps;
    try {
      // origin='vps': der App-Host-Anteil hat sein eigenes Badge
      // ([[pendingAppHostApplications]]) — sonst zählte beides doppelt.
      apps = await adminInstancesApi.listApplications('pending', 'vps');
    } catch {
      // Transient (Netz) / nicht Cloud / nicht Admin → leise ignorieren,
      // der nächste Tick versucht es erneut.
      return;
    }
    const n = apps.length;
    this.count = n;

    const lastSeen = this._lastSeen();
    if (lastSeen < 0) {
      // Erste Messung dieser Installation → still als Baseline merken.
      this._setLastSeen(n);
      return;
    }
    if (n > lastSeen) {
      toast.info(m.instance_apps_toast_title(), {
        description: m.instance_apps_toast_body({ count: n })
      });
    }
    // Baseline immer nachziehen — auch bei Rückgang (Approvals/Rejections).
    this._setLastSeen(n);
  }
}

export const pendingInstanceApps = new PendingInstanceApps();
