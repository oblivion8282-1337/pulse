/**
 * Gateway-Connection-Pool — Phase 4.2.
 *
 * Eine `GatewayConnection` pro `ServerEntry`. Wird lazy beim ersten
 * `for(serverId)`-Aufruf erzeugt. `closeAll()` bei Sign-Out, `close(id)`
 * beim Server-Remove.
 *
 * Backwards-Compat: `connection.ts::gateway` proxied auf die Active-Server-
 * Connection — alte Call-Sites wie `gateway.connect()` funktionieren weiter,
 * weil sie immer durch den Pool zur aktuell aktiven Connection geroutet werden.
 */

import { GatewayConnection } from './gateway-connection';
import { serversStore } from '$lib/api/servers.svelte';
import type { ServerEntry } from '$lib/api/servers.svelte';

class GatewayPool {
  readonly #connections = new Map<string, GatewayConnection>();

  /** Holt die Connection für `serverId` oder erzeugt sie. Wirft wenn kein
   *  ServerEntry existiert (Caller hat schon Server-Switch gemacht aber der
   *  Eintrag wurde gelöscht — Hard-Fehler, kein silenter Fallback). */
  for(serverId: string): GatewayConnection {
    const cached = this.#connections.get(serverId);
    if (cached) return cached;
    const entry: ServerEntry | undefined = serversStore.find(serverId);
    if (!entry) {
      throw new Error(`GatewayPool: unknown serverId ${serverId}`);
    }
    const conn = new GatewayConnection({
      serverId: entry.id,
      hostname: entry.hostname,
      isCloud: entry.isCloud,
      instanceId: entry.instance_id,
    });
    this.#connections.set(serverId, conn);
    return conn;
  }

  /** Existierende Connection ohne Erzeugung holen (für Sign-Out etc.). */
  peek(serverId: string): GatewayConnection | undefined {
    return this.#connections.get(serverId);
  }

  /** Schließt eine Connection und entfernt sie aus dem Pool. */
  close(serverId: string): void {
    const conn = this.#connections.get(serverId);
    if (!conn) return;
    conn.disconnect();
    this.#connections.delete(serverId);
  }

  /** Schließt alle Connections (Sign-Out). */
  closeAll(): void {
    for (const conn of this.#connections.values()) conn.disconnect();
    this.#connections.clear();
  }

  /** Debug/Test: gibt die aktiven Connection-IDs zurück. */
  ids(): string[] {
    return Array.from(this.#connections.keys());
  }
}

export const gatewayPool = new GatewayPool();
