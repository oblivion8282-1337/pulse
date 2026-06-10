/**
 * Owner-Benachrichtigung für eigene Self-Host-Anträge.
 *
 * Gegenstück zur Admin-Seite ([[pendingInstanceApps]]): Wenn ein Admin den
 * Antrag genehmigt (oder ablehnt), bekam der Antragsteller bisher nichts mit —
 * approve macht backend-seitig nur DB + Rückgabe an den Admin. Dieser Store
 * pollt die eigenen Anträge und toastet beim Übergang pending → approved /
 * rejected.
 *
 * Effizienz: Es wird nur gepollt, wenn überhaupt ein beobachteter Antrag offen
 * ist. Beim Einreichen registriert `SelfHostApplication` den Antrag via
 * `register()`; ohne offenen Antrag macht `_poll()` keinen Request. Der Watch-
 * Zustand liegt in localStorage, damit „genehmigt während weg" beim nächsten
 * App-Start noch erkannt wird (gerätelokal — v1-Grenze).
 */

import { instancesApi } from '$lib/api/instances';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 90_000;
const LS_WATCH = 'pulse.instanceAppWatch';
const LS_ACK = 'pulse.instanceSetupAck';

type WatchMap = Record<string, string>; // appId → zuletzt gesehener Status

class MyInstanceApplications {
  /**
   * Anzahl genehmigter Anträge, die der Owner noch nicht „gesehen" hat
   * (→ roter Punkt am UserFooter, bis er „Meine Instanzen" öffnet). Persistent
   * über Reload via Watch-Map (approved) minus Ack-Set.
   */
  pendingSetup = $state(0);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  /** Beim Einreichen aufrufen — markiert den Antrag als zu beobachten. */
  register(appId: string): void {
    if (typeof window === 'undefined') return;
    const w = this._load();
    w[appId] = 'pending';
    this._save(w);
    // Falls der Poller schon läuft, greift er beim nächsten Tick; sonst starten.
    this.start();
  }

  start(): void {
    if (this._running || typeof window === 'undefined') return;
    this._running = true;
    this._recompute();
    void this._poll();
    this._timer = setInterval(() => void this._poll(), POLL_MS);
  }

  /**
   * Owner hat seine Instanzen angesehen → roten Punkt löschen. Aufgerufen vom
   * MyInstances-Mount. Merkt alle aktuell genehmigten Anträge als „gesehen".
   */
  acknowledge(): void {
    if (typeof window === 'undefined') return;
    const watch = this._load();
    const ack = this._loadAck();
    for (const [id, status] of Object.entries(watch)) {
      if (status === 'approved') ack[id] = true;
    }
    window.localStorage.setItem(LS_ACK, JSON.stringify(ack));
    this._recompute();
  }

  private _loadAck(): Record<string, boolean> {
    try {
      return JSON.parse(window.localStorage.getItem(LS_ACK) || '{}');
    } catch {
      return {};
    }
  }

  /** pendingSetup = genehmigte Anträge in der Watch-Map, die noch nicht ge-ack't sind. */
  private _recompute(): void {
    if (typeof window === 'undefined') return;
    const watch = this._load();
    const ack = this._loadAck();
    this.pendingSetup = Object.entries(watch).filter(
      ([id, status]) => status === 'approved' && !ack[id]
    ).length;
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
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
      apps = await instancesApi.listMyApplications('all');
    } catch {
      return; // transient → nächster Tick
    }
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
          toast.success(m.instance_app_approved_toast_title(), {
            description: m.instance_app_approved_toast_body({ hostname: app.hostname })
          });
        } else if (app.status === 'rejected') {
          const reason = app.rejection_reason ? ` — ${app.rejection_reason}` : '';
          toast.error(m.instance_app_rejected_toast_title(), {
            description: m.instance_app_rejected_toast_body({ hostname: app.hostname }) + reason
          });
        }
        watch[id] = app.status;
        changed = true;
      }
    }
    if (changed) {
      this._save(watch);
      this._recompute();
    }
  }
}

export const myInstanceApplications = new MyInstanceApplications();
