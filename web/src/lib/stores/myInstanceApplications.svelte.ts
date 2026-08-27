/**
 * Owner-Benachrichtigung für eigene Self-Host-Anträge.
 *
 * Gegenstück zur Admin-Seite ([[pendingInstanceApps]]): Wenn ein Admin den
 * Antrag genehmigt (oder ablehnt), bekam der Antragsteller bisher nichts mit —
 * approve macht backend-seitig nur DB + Rückgabe an den Admin. Dieser Store
 * leitet den „einrichten"-Punkt aus dem **Server-Zustand** ab (genehmigte
 * Anträge), nicht aus einer lokal abgelegten Watch-Map.
 *
 * Warum server-abgeleitet: Der frühere Ansatz schrieb beim Absenden eine
 * gerätelokale Watch-Map und pollte nur, wenn dort ein offener Antrag stand.
 * Folge — der rote „einrichten"-Punkt erschien NUR auf dem Gerät, auf dem der
 * Antrag abgesendet wurde. Loggte sich der Owner woanders ein, sah er nichts.
 * Jetzt fragt jeder Client beim Start einmal die eigenen Anträge ab; ein
 * genehmigter, noch nicht „gesehener" Antrag zeigt den Punkt — auf jedem Gerät.
 *
 * Gerätelokal bleibt nur das „gesehen"-Ack (welche genehmigten Anträge der
 * User auf DIESEM Gerät schon in „Meine Instanzen" geöffnet hat) und das
 * Toast-„schon benachrichtigt"-Set (damit ein bereits genehmigter Antrag auf
 * einem neuen Gerät den Punkt zeigt, aber keinen veralteten Toast).
 */

import { instancesApi } from '$lib/api/instances';
import { serversStore } from '$lib/api/servers.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';

const POLL_MS = 90_000;
const LS_ACK = 'pulse.instanceSetupAck'; // appId → true (auf diesem Gerät „gesehen")
const LS_NOTIFIED = 'pulse.instanceAppNotified'; // appId → true (Toast schon gezeigt)

type IdSet = Record<string, boolean>;

class MyInstanceApplications {
  /**
   * Anzahl genehmigter Anträge, die der Owner auf diesem Gerät noch nicht
   * „gesehen" hat (→ roter Punkt am UserFooter, bis er „Meine Instanzen"
   * öffnet). Aus dem Server-Zustand abgeleitet → auf jedem Gerät sichtbar.
   */
  pendingSetup = $state(0);

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  /** IDs der zuletzt vom Server gesehenen genehmigten Anträge. */
  private _approvedIds: string[] = [];
  /** Beim allerersten Poll keine Toasts für bereits abgeschlossene Anträge. */
  private _firstPollDone = false;

  /** Beim Einreichen aufrufen — sofort pollen, damit der Status zeitnah kommt. */
  register(_appId?: string): void {
    if (typeof window === 'undefined') return;
    this.start();
    void this._poll();
  }

  /** Sofort neu laden — vom `application_decided`-WS-Ereignis gerufen, damit
   *  Toast und roter Punkt nicht bis zum nächsten Poll-Tick warten. */
  refresh(): void {
    void this._poll();
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
   * Owner hat seine Instanzen angesehen → roten Punkt auf DIESEM Gerät löschen.
   * Aufgerufen vom MyInstances-Mount. Merkt alle aktuell genehmigten Anträge
   * als „gesehen".
   */
  acknowledge(): void {
    if (typeof window === 'undefined') return;
    const ack = this._loadSet(LS_ACK);
    for (const id of this._approvedIds) ack[id] = true;
    this._saveSet(LS_ACK, ack);
    this._recompute();
  }

  /**
   * Account-Wechsel am selben Gerät / Logout: Ack-/Notified-State des
   * Vorgängers verwerfen (Keys sind gerätelokal + flach, nicht user-gescopet).
   */
  reset(): void {
    this.stop();
    this.pendingSetup = 0;
    this._approvedIds = [];
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(LS_ACK);
      window.localStorage.removeItem(LS_NOTIFIED);
    } catch {
      /* ignore */
    }
  }

  /** pendingSetup = genehmigte Anträge, die auf diesem Gerät nicht ge-ack't sind. */
  private _recompute(): void {
    if (typeof window === 'undefined') return;
    const ack = this._loadSet(LS_ACK);
    this.pendingSetup = this._approvedIds.filter((id) => !ack[id]).length;
  }

  private _loadSet(key: string): IdSet {
    try {
      return JSON.parse(window.localStorage.getItem(key) || '{}') as IdSet;
    } catch {
      return {};
    }
  }

  private _saveSet(key: string, set: IdSet): void {
    window.localStorage.setItem(key, JSON.stringify(set));
  }

  private async _poll(): Promise<void> {
    if (!auth.user) return;

    let apps;
    try {
      // origin='vps': App-Host-Anträge beobachtet [[myAppHostApplications]]
      // (eigene Toast-Texte) — sonst würde beides doppelt benachrichtigen.
      apps = await instancesApi.listMyApplications('all', 'vps');
    } catch {
      return; // transient → nächster Tick
    }

    // Normaler User ohne Self-Host-Antrag: nichts zu beobachten → Poller
    // stoppen, damit nicht jeder Cloud-User alle 90s eine Anfrage feuert.
    if (apps.length === 0) {
      this._approvedIds = [];
      this._recompute();
      this.stop();
      return;
    }

    this._approvedIds = apps.filter((a) => a.status === 'approved').map((a) => a.id);

    // Toast für JEDEN noch nicht benachrichtigten Statuswechsel. Auf einem
    // frischen Gerät wird ein längst genehmigter/abgelehnter Antrag NICHT
    // nachträglich getoastet — er gilt direkt als „benachrichtigt" (der Punkt
    // zeigt ihn trotzdem). So nervt kein veralteter Toast nach Re-Login.
    const notified = this._loadSet(LS_NOTIFIED);
    let notifiedChanged = false;
    for (const app of apps) {
      if (app.status === 'pending' || notified[app.id]) continue;
      // Erstes Sehen dieses Geräts UND der Antrag ist neu (kein älterer
      // Snapshot): toasten. „Neu" = noch in keinem Notified-Set. Wir toasten
      // beim allerersten Poll-Lauf nicht für Alt-Anträge — heuristisch via
      // _firstPollDone unten.
      if (this._firstPollDone) {
        if (app.status === 'approved') {
          toast.success(m.instance_app_approved_toast_title(), {
            description: m.instance_app_approved_toast_body({ hostname: app.hostname })
          });
          // Liste angleichen. Seit 2026-08-27 erscheint die genehmigte
          // Instanz hier NICHT mehr in der Server-Leiste — dafür fehlen ihr
          // die abgeholten Zugangsdaten (`set_up`). Der Abgleich lohnt
          // trotzdem: er ist der Weg, auf dem sie auftaucht, sobald der
          // Installer gelaufen ist, ohne dass jemand neu anmelden muss.
          void serversStore.hydrateFromBackend();
        } else if (app.status === 'rejected') {
          const reason = app.rejection_reason ? ` — ${app.rejection_reason}` : '';
          toast.error(m.instance_app_rejected_toast_title(), {
            description: m.instance_app_rejected_toast_body({ hostname: app.hostname }) + reason
          });
        }
      }
      notified[app.id] = true;
      notifiedChanged = true;
    }
    if (notifiedChanged) this._saveSet(LS_NOTIFIED, notified);
    this._firstPollDone = true;

    this._recompute();
  }
}

export const myInstanceApplications = new MyInstanceApplications();
