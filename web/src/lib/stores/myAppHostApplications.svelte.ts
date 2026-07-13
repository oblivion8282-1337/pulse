/**
 * Owner-Benachrichtigung für eigene App-Hosting-Anträge.
 *
 * Spiegel von [[myInstanceApplications]] für App-Hosting. Läuft seit dem
 * vereinten Antragssystem über die vereinten Pfade (origin='app_host').
 * Polling-basiert:
 * - Beim Submit registriert das vereinte Antragsformular den Antrag.
 * - Ohne offenen Antrag macht `_poll()` keinen Request (effizient).
 * - Übergang pending → approved/rejected toastet den User.
 *
 * Watch-Map lebt in localStorage, damit „genehmigt während weg" beim nächsten
 * App-Start noch erkannt wird (gerätelokal — v1-Grenze).
 *
 * Der Poll ist nur noch das Netz: das WS-Ereignis `application_decided`
 * (auth-svc → user:events) ruft `refresh()`, sobald der Admin entscheidet.
 * Der Pending-Count für den Admin-Badge liegt in [[pendingAppHostApplications]].
 *
 * `pendingSetup` treibt den roten Punkt am UserFooter: eine genehmigte
 * Freischaltung, die der User auf DIESEM Gerät noch nicht angesehen hat.
 * Ohne ihn bekam er zwar einen Toast, wusste danach aber nicht, wohin klicken.
 * Gleiches Muster wie [[myInstanceApplications]].
 */

import { instancesApi, type InstanceApplication } from '$lib/api/instances';
import { serversStore } from '$lib/api/servers.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 90_000;
const LS_WATCH = 'pulse.appHostAppWatch';
const LS_ACK = 'pulse.appHostSetupAck'; // appId → true (auf diesem Gerät „gesehen")

type WatchMap = Record<string, string>; // appId → zuletzt gesehener Status

class MyAppHostApplications {
  /**
   * Liste aller eigenen Anträge (für UI-Rendering im Dialog). Wird beim
   * `register()` und nach jedem Poll aktualisiert.
   */
  applications = $state<InstanceApplication[]>([]);
  loading = $state(false);

  /** Genehmigte Freischaltungen, die auf diesem Gerät noch nicht angesehen
   *  wurden → roter Punkt am UserFooter, bis er die Self-Host-Einstellungen
   *  öffnet. */
  pendingSetup = $state(0);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  /** Beim Einreichen aufrufen — markiert den Antrag als zu beobachten. */
  register(app: InstanceApplication): void {
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
      this.applications = await instancesApi.listMyApplications('all', 'app_host');
      this._recompute();
    } catch {
      /* transient → still ignorieren */
    } finally {
      this.loading = false;
    }
  }

  /** Sofort neu laden — vom `application_decided`-WS-Ereignis gerufen. Der
   *  Poll bleibt als Netz für den Fall, dass die WS-Verbindung gerade fehlt.
   *  `force`, weil die Watch-Map gerätelokal ist: wurde der Antrag auf einem
   *  anderen Gerät gestellt, steht hier nichts „Offenes" und der normale Poll
   *  würde ohne Request zurückkehren. */
  refresh(): void {
    void this._poll(true);
  }

  /** User hat die Self-Host-Einstellungen geöffnet → Punkt auf DIESEM Gerät
   *  löschen. Merkt alle aktuell genehmigten Anträge als „gesehen". */
  acknowledge(): void {
    if (typeof window === 'undefined') return;
    const ack = this._loadAck();
    for (const a of this.applications) {
      if (a.status === 'approved') ack[a.id] = true;
    }
    this._saveAck(ack);
    this._recompute();
  }

  private _recompute(): void {
    if (typeof window === 'undefined') return;
    const ack = this._loadAck();
    this.pendingSetup = this.applications.filter(
      (a) => a.status === 'approved' && !ack[a.id]
    ).length;
  }

  private _loadAck(): Record<string, boolean> {
    try {
      return JSON.parse(window.localStorage.getItem(LS_ACK) || '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  private _saveAck(ack: Record<string, boolean>): void {
    try {
      window.localStorage.setItem(LS_ACK, JSON.stringify(ack));
    } catch {
      /* Quota/Private-Browsing → Punkt bleibt, harmlos */
    }
  }

  start(): void {
    if (this._running || typeof window === 'undefined') return;
    this._running = true;
    // Erster Lauf erzwungen: auf einem frischen Gerät ist die Watch-Map leer,
    // eine längst genehmigte Freischaltung soll den Punkt trotzdem zeigen.
    void this._poll(true);
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
    this.pendingSetup = 0;
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(LS_WATCH);
      window.localStorage.removeItem(LS_ACK);
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

  private async _poll(force = false): Promise<void> {
    if (!auth.user) return;
    const watch = this._load();
    if (!force && !this._hasPending(watch)) return; // nichts offen → kein Request

    let apps;
    try {
      apps = await instancesApi.listMyApplications('all', 'app_host');
    } catch {
      return; // transient → nächster Tick
    }
    this.applications = apps;
    this._recompute();
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
          // In-Session-Reload: das frisch gesetzte self_host_enabled ziehen,
          // damit die Karte ohne App-Neustart aus dem „gesperrt"-Zustand kommt
          // und den Download zeigt.
          void auth.refreshUser();
          // Die auto-provisionierte App-Host-Instanz sofort in die
          // Server-Leiste ziehen (statt auf den nächsten Login zu warten).
          void serversStore.hydrateFromBackend();
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
