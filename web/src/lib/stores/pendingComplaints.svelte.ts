/**
 * Offene Betreiber-Beschwerden — Cloud-Admin-Benachrichtigung.
 *
 * Spiegel von [[pendingAppHostApplications]]: pollt periodisch die Anzahl neuer
 * Beschwerden und macht sie reaktiv (gelbe Badge über dem Icon im `UserFooter`)
 * + toastet bei Zuwachs während einer Session — damit der Betreiber weiß, dass
 * eine Meldung reinkam, ohne das Admin-Postfach offen zu haben.
 *
 * Nur **Cloud-Admins** pollen (Endpoint ist server-seitig admin-gegated).
 */

import { adminComplaintsApi } from '$lib/api/complaints';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 60_000;
const LS_LAST_SEEN = 'pulse.complaints.lastSeen';

class PendingComplaints {
  /** Anzahl offener (status=new) Beschwerden. 0 für Nicht-Admins. */
  count = $state(0);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  start(): void {
    if (this._running || typeof window === 'undefined') return;
    this._running = true;
    void this._poll();
    this._timer = setInterval(() => void this._poll(), POLL_MS);
  }

  /** Sofort neu laden — z.B. nachdem der Admin eine Beschwerde bearbeitet hat. */
  refresh(): void {
    void this._poll();
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
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
    let items;
    try {
      items = await adminComplaintsApi.list('new');
    } catch {
      return; // transient / nicht Admin → nächster Tick
    }
    const n = items.length;
    this.count = n;

    const lastSeen = this._lastSeen();
    if (lastSeen < 0) {
      this._setLastSeen(n);
      return;
    }
    if (n > lastSeen) {
      toast.info(m.complaints_pending_toast_title(), {
        description: m.complaints_pending_toast_body({ count: n })
      });
    }
    this._setLastSeen(n);
  }
}

export const pendingComplaints = new PendingComplaints();
