/**
 * Owner-Benachrichtigung für eigene App-Hosting-Anträge.
 *
 * Spiegel von [[myInstanceApplications]] für App-Hosting. Polling-basiert:
 * - Beim Submit registriert der AppHostApplicationDialog den Antrag.
 * - Ohne offenen Antrag macht `_poll()` keinen Request (effizient).
 * - Übergang pending → approved/rejected toastet den User.
 *
 * Watch-Map lebt in localStorage, damit „genehmigt während weg" beim nächsten
 * App-Start noch erkannt wird (gerätelokal — v1-Grenze).
 *
 * Admin pusht nicht (kein WS-Broadcast im Backend — bewusst schlank, ein
 * Cloud-Admin öffnet das Tab sowieso aktiv). Der Pending-Count für den
 * Admin-Badge liegt in [[pendingAppHostApplications]].
 */

import { appHostApplicationsApi, type AppHostApplication } from '$lib/api/appHostApplications';
import { auth } from '$lib/stores/auth.svelte';
import { hostStore } from '$lib/host/hostStore.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 90_000;
const LS_WATCH = 'pulse.appHostAppWatch';

type WatchMap = Record<string, string>; // appId → zuletzt gesehener Status

class MyAppHostApplications {
  /**
   * Liste aller eigenen Anträge (für UI-Rendering im Dialog). Wird beim
   * `register()` und nach jedem Poll aktualisiert.
   */
  applications = $state<AppHostApplication[]>([]);
  loading = $state(false);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  /** Beim Einreichen aufrufen — markiert den Antrag als zu beobachten. */
  register(app: AppHostApplication): void {
    if (typeof window === 'undefined') return;
    // Liste sofort aktualisieren, damit das Dialog-UI den neuen Antrag zeigt.
    this.applications = [app, ...this.applications.filter((a) => a.id !== app.id)];
    const w = this._load();
    w[app.id] = 'pending';
    this._save(w);
    this.start();
  }

  /** Liste einmalig laden (z.B. wenn der User das Dialog öffnet). */
  async reload(): Promise<void> {
    if (!auth.user) return;
    this.loading = true;
    try {
      this.applications = await appHostApplicationsApi.listMyApplications('all');
    } catch {
      /* transient → still ignorieren */
    } finally {
      this.loading = false;
    }
  }

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
  }

  /**
   * Account-Wechsel am selben Gerät / Logout: Watch-State des Vorgängers
   * verwerfen (Keys sind gerätelokal + flach, nicht user-gescopet).
   */
  reset(): void {
    this.stop();
    this.applications = [];
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(LS_WATCH);
    } catch {
      /* ignore */
    }
  }

  private _load(): WatchMap {
    try {
      return JSON.parse(window.localStorage.getItem(LS_WATCH) || '{}') as WatchMap;
    } catch {
      return {};
    }
  }

  private _save(w: WatchMap): void {
    window.localStorage.setItem(LS_WATCH, JSON.stringify(w));
  }

  private _hasPending(w: WatchMap): boolean {
    return Object.values(w).some((s) => s === 'pending');
  }

  private async _poll(): Promise<void> {
    if (!auth.user) return;
    const watch = this._load();
    if (!this._hasPending(watch)) return; // nichts offen → kein Request

    let apps;
    try {
      apps = await appHostApplicationsApi.listMyApplications('all');
    } catch {
      return; // transient → nächster Tick
    }
    this.applications = apps;
    const byId = new Map(apps.map((a) => [a.id, a]));

    let changed = false;
    for (const id of Object.keys(watch)) {
      const app = byId.get(id);
      if (!app) {
        delete watch[id];
        changed = true;
        continue;
      }
      if (watch[id] === 'pending' && app.status !== 'pending') {
        if (app.status === 'approved') {
          toast.success(m.app_host_approved_toast_title(), {
            description: m.app_host_approved_toast_body()
          });
          // In-Session-Reload: das frisch gesetzte self_host_enabled ziehen +
          // die gerade provisionierte Instanz laden, damit die Hosting-Karte
          // ohne App-Neustart aus dem „gesperrt"-Zustand kommt.
          void auth.refreshUser().then(() => hostStore.refreshInstances());
        } else if (app.status === 'rejected') {
          const reason = app.rejection_reason ? ` — ${app.rejection_reason}` : '';
          toast.error(m.app_host_rejected_toast_title(), {
            description: m.app_host_rejected_toast_body() + reason
          });
        }
        watch[id] = app.status;
        changed = true;
      }
    }
    if (changed) this._save(watch);
  }
}

export const myAppHostApplications = new MyAppHostApplications();
