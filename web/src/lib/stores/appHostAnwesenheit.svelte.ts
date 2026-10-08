/**
 * Anwesenheit der App-Hosting-Server — „schläft der gerade?"
 *
 * App-Host-Server (origin='app_host') laufen nur, solange der Rechner ihres
 * Hosts an ist; „aus" ist der Normalzustand, nicht die Ausnahme (2026-10-03).
 * Dieser Store hält den Cloud-Telefonbuch-Stand im Takt frisch — ein billiger
 * Request pro Server — und beantwortet die Frage „offline?" (synchron fürs
 * UI, asynchron für die Weichen).
 *
 * Die Direkt-Weichen (transport, gateway-_openSocket, serverGuilds) fragen
 * HIER nach, bevor sie irgendetwas Teures anfangen: Ein bekannt schlafender
 * Server wird nicht geweckt — keine WebRTC-Verhandlung, keine ICE-Timeouts,
 * sofort die ehrliche Offline-Antwort.
 *
 * Bewusst konservativ: Nur eine positive Cloud-Antwort (200 mit online:false
 * oder 404 „kein Eintrag") zählt als „offline". Netz-/Deploy-Fehler (401, 5xx)
 * sind „unbekannt" → die Weichen verhalten sich wie bisher (Dial-Versuch),
 * statt einen wachenden Server fälschlich für tot zu erklären.
 */

import { serversStore } from '$lib/api/servers.svelte';
import { cloudAuthBasis } from '$lib/direct/registry';
import { deuteTelefonbuch } from '$lib/direct/policy';

const TAKT_MS = 120_000;
/** Wie lange eine Messung als verlässlich gilt — danach schaut die async-
 *  Variante einmal frisch nach (Klick auf einen Server, der gerade
 *  hochgefahren sein könnte). Kürzer als der Takt, damit der Poll den
 *  Normalfall deckt. */
const FRISCH_MS = 75_000;

type Eintrag = { offline: boolean; gemessen: number };

class AppHostAnwesenheit {
  private eintraege = $state<Record<string, Eintrag>>({});
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _inflight = new Map<string, Promise<boolean>>();

  /** Sync für die UI (Rail-Dimmung): true nur bei FRISCHER Offline-Messung. */
  schlaeft(instanceId: string | null | undefined): boolean {
    if (!instanceId) return false;
    const e = this.eintraege[instanceId];
    return !!e && e.offline && Date.now() - e.gemessen < FRISCH_MS;
  }

  /** Für die Weichen (async): frischer Stand oder einmal frisch nachschauen.
   *  Parallele Aufrufer teilen sich denselben Nachschauen-Lauf (Map). */
  async istOffline(instanceId: string): Promise<boolean> {
    if (this.schlaeft(instanceId)) return true;
    if (!instanceId) return false;
    const laufend = this._inflight.get(instanceId);
    if (laufend) return laufend;
    const p = this._messe(instanceId).finally(() => this._inflight.delete(instanceId));
    this._inflight.set(instanceId, p);
    return p;
  }

  /** Misst FRISCH, ignoriert den Cache — für den Retry-Knopf: Ein gerade
   *  gestarteter Host-Rechner soll sofort erkannt werden, nicht erst nach
   *  Ablauf der Frische-Frist. */
  async messeJetzt(instanceId: string): Promise<boolean> {
    if (!instanceId) return false;
    return this._messe(instanceId);
  }

  /** Startet den Takt (idempotent) — initial sofort, dann alle 2 min. */
  start(): void {
    if (this._running || typeof window === 'undefined') return;
    this._running = true;
    void this._alleMessen();
    this._timer = setInterval(() => void this._alleMessen(), TAKT_MS);
  }

  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
  }

  /** Stand von außen übernehmen (Push `instance_status`) — zählt wie eine
   *  frische Messung. */
  vermerke(instanceId: string, offline: boolean): void {
    this.eintraege = { ...this.eintraege, [instanceId]: { offline, gemessen: Date.now() } };
  }

  /** Server wurde entfernt → Messung wegwerfen. */
  forget(instanceId: string): void {
    if (!(instanceId in this.eintraege)) return;
    const next = { ...this.eintraege };
    delete next[instanceId];
    this.eintraege = next;
  }

  /** Sign-Out — alles weg. */
  clear(): void {
    this.eintraege = {};
  }

  private async _alleMessen(): Promise<void> {
    const ids = serversStore.servers
      .filter((s) => s.origin === 'app_host' && s.instance_id)
      .map((s) => s.instance_id!);
    await Promise.allSettled(ids.map((id) => this._messe(id)));
  }

  /** Eine Messung (Deutung s. deuteTelefonbuch): offline wird gemessen und
   *  frisch vermerkt; unbekannt ändert nichts — der alte Eintrag verfällt
   *  über FRISCH_MS, bis wieder eine belastbare Antwort kommt. */
  private async _messe(instanceId: string): Promise<boolean> {
    try {
      const r = await fetch(
        `${cloudAuthBasis()}/me/instances/${instanceId}/direct-endpoint`,
        { credentials: 'include' },
      );
      const online =
        r.status >= 200 && r.status < 300
          ? ((await r.json()) as { online?: boolean }).online
          : undefined;
      const deutung = deuteTelefonbuch(r.status, online);
      if (deutung === 'unbekannt') return false;
      const offline = deutung === 'offline';
      this.eintraege = {
        ...this.eintraege,
        [instanceId]: { offline, gemessen: Date.now() },
      };
      // Belastbare Messung → auch die Leiste (lib/servers/anzeige.ts). Fängt
      // ein verlorenes `instance_status` ab (WS-Neuaufbau, Cloud-Deploy).
      serversStore.setzeInstanzStatus(instanceId, { online: !offline });
      return offline;
    } catch {
      /* Netz weg → unbekannt */
      return false;
    }
  }
}

export const appHostAnwesenheit = new AppHostAnwesenheit();
