/**
 * Active-Server-Store — Phase 4.1 Foundation
 *
 * Merkt sich welcher Server gerade aktiv ist.
 * localStorage-Key: pulse.active_server (lokale UUID)
 */

import { serversStore, CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import type { ServerEntry } from '$lib/api/servers.svelte';
import { resetServerScopedStores } from './multi-server-reset';
import { gatewayPool } from '$lib/ws/gateway-pool.svelte';

export type { ServerEntry };

/** Minimal interface — wird von init() erwartet, passt auf ServersStore. */
type ServerList = {
  servers: ServerEntry[];
  find(id: string): ServerEntry | undefined;
};

const LS_KEY = 'pulse.active_server';

class ActiveServer {
  serverId = $state<string>('');
  /**
   * Erst nach `init()` true. Schützt `set()` davor, beim allerersten
   * Setzen (Hydrate aus localStorage) den Reset-Pfad zu triggern — das
   * würde die noch leeren Stores nochmal leeren und sofort eine
   * Connection auf den Pool stoßen, bevor `auth.hydrate()` den
   * Access-Token in den Storage gelegt hat.
   */
  private _initialized = false;

  /**
   * Muss synchron nach serversStore.init() aufgerufen werden.
   * Liest pulse.active_server aus localStorage; fällt auf ersten
   * Cloud-Server zurück falls der gespeicherte Wert nicht mehr existiert.
   */
  init(servers: ServerList): void {
    let persisted: string | null = null;
    if (typeof window !== 'undefined') {
      persisted = window.localStorage.getItem(LS_KEY);
    }

    if (persisted && servers.find(persisted)) {
      this.serverId = persisted;
    } else {
      // Fallback: erster Cloud-Server
      const cloud = servers.servers.find(
        (s: ServerEntry) => s.isCloud && s.hostname === CLOUD_HOSTNAME,
      );
      this.serverId = cloud?.id ?? servers.servers[0]?.id ?? '';
      this._persist();
    }
    this._initialized = true;
  }

  /**
   * Setzt den aktiven Server. Vor `init()` (oder bei No-Op) tut nichts.
   * Nach `init()`:
   *  1. Persist
   *  2. Alle Server-scoped Stores leeren
   *  3. Neue Connection im `gatewayPool` proaktiv anstoßen — der
   *     ready-Frame befüllt die geleerten Stores wieder.
   *
   * Alte Connections bleiben offen (Phase 4.5: bewusst, damit später ohne
   * Service-Worker Background-Notifications möglich sind). `closeAll()`
   * passiert nur beim Sign-Out.
   */
  set(serverId: string): void {
    if (!this._initialized) {
      // Erst-Set über init() — nur State setzen, keinen Reset auslösen.
      this.serverId = serverId;
      this._persist();
      return;
    }
    if (this.serverId === serverId) return; // No-Op
    this.serverId = serverId;
    this._persist();

    resetServerScopedStores();

    try {
      const conn = gatewayPool.for(serverId);
      // Global-Friends Stufe 1 (Option B): die Ziel-Connection bleibt über
      // Switches hinweg offen (Background-Cloud-Pattern). Ist sie schon offen
      // und hat einen ready gecached, returnt `connect()` unten früh → KEIN
      // neuer ready, der den eben geleerten Server-Teil neu seedet. Darum den
      // gecachten ready synchron mit `_isActive=true` re-dispatchen. Das ist
      // reiner In-Memory-Replay (kein Socket-Drop), berührt NUR diese
      // Connection und lässt die Hintergrund-Cloud-Connection unangetastet.
      // Frische/noch-nicht-ready Connection → Replay liefert false, der
      // `connect()` unten holt den echten ready.
      conn.replayReadyForActivation();
      // Der Replay seedet aus dem gecachten ready (Stand vom Connect) — Live-
      // voice/stream/watch-Updates seither fehlen darin. Direkt einen frischen
      // ready vom Server nachfordern, damit z.B. der eigene Voice-Channel-
      // Beitritt nach dem Zurückwechseln wieder sichtbar ist. No-op auf einer
      // noch-nicht-ready Connection — der connect() unten holt dann den echten.
      conn.requestResync();
      // Proaktiv konnektieren. Idempotent: schon offen → no-op; sonst landet
      // der echte ready-Frame früh, statt erst bei der ersten User-Action.
      void conn.connect().catch((err: unknown) => {
        console.warn('[active-server] connect failed for', serverId, err);
      });
    } catch (err) {
      // gatewayPool.for() wirft wenn der ServerEntry weg ist (race mit
      // Server-Remove). Caller sollte nicht in den Switch-Pfad gehen,
      // dieser catch ist nur Defensive.
      console.warn('[active-server] no pool entry for', serverId, err);
    }
  }

  get current(): ServerEntry | undefined {
    return serversStore.find(this.serverId);
  }

  private _persist(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LS_KEY, this.serverId);
  }
}

export const activeServer = new ActiveServer();
