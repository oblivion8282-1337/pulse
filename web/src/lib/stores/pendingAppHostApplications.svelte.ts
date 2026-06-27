/**
 * Pending App-Hosting-Anträge — Cloud-Admin-Benachrichtigung.
 *
 * Spiegel von [[pendingInstanceApps]] für App-Hosting. Pollt periodisch den
 * Pending-Zähler und macht ihn reaktiv (Badge in `UserFooter`) + toastet bei
 * Zuwachs während einer Session.
 *
 * Nur **Cloud-Admins** pollen — sonst 403/irrelevant (Endpoint ist
 * server-seitig cloud-gegated + admin-gegated).
 */

import { adminAppHostApplicationsApi } from '$lib/api/appHostApplications';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 60_000;
const LS_LAST_SEEN = 'pulse.appHostApps.lastSeen';

class PendingAppHostApplications {
  /** Anzahl offener (pending) Anträge. 0 für Nicht-Admins. */
  count = $state(0);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  start(): void {
    if (this._running || typeof window === 'undefined') return;
    this._running = true;
    void this._poll();
    this._timer = setInterval(() => void this._poll(), POLL_MS);
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    // Zähler zurücksetzen, damit nach Sign-Out + Re-Login kein veralteter
    // Badge-Stand kurz aufblitzt, bevor der erste Poll greift.
    this.count = 0;
  }

  private _lastSeen(): number {
    const raw = window.localStorage.getItem(LS_LAST_SEEN);
    if (raw === null) return -1;
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }

  private _setLastSeen(n: number): void {
    window.localStorage.setItem(LS_LAST_SEEN, String(n));
  }

  private async _poll(): Promise<void> {
    if (!auth.user?.is_admin) {
      this.count = 0;
      return;
    }
    let apps;
    try {
      apps = await adminAppHostApplicationsApi.listApplications('pending');
    } catch {
      return; // transient / nicht Cloud / nicht Admin → nächster Tick
    }
    const n = apps.length;
    this.count = n;

    const lastSeen = this._lastSeen();
    if (lastSeen < 0) {
      this._setLastSeen(n);
      return;
    }
    if (n > lastSeen) {
      toast.info(m.app_host_pending_toast_title(), {
        description: m.app_host_pending_toast_body({ count: n })
      });
    }
    this._setLastSeen(n);
  }
}

export const pendingAppHostApplications = new PendingAppHostApplications();