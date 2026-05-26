/**
 * Active-Server-Store — Phase 4.1 Foundation
 *
 * Merkt sich welcher Server gerade aktiv ist.
 * localStorage-Key: pulse.active_server (lokale UUID)
 */

import { serversStore, CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import type { ServerEntry } from '$lib/api/servers.svelte';

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
  }

  set(serverId: string): void {
    this.serverId = serverId;
    this._persist();
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
