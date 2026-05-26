/**
 * Reactive Bridge für GatewayConnection.state — Phase 4.3.
 *
 * `gateway-connection.ts` hält `state` als plain Property (kein $state) damit
 * der Konstruktor nicht an Svelte-Runes gekoppelt ist (Tests, evtl. Worker-
 * Re-Use). Diese Brücke pollt 1×/Sekunde alle bekannten Pool-Connections und
 * exposed das als `$state`-Map für UI-Banner & Status-Dots.
 *
 * Bewusst Poll statt Event-Bus: die State-Transitions sind selten (open ↔
 * incompatible ↔ updating ↔ ...), und 1Hz reicht für die UX. Kein neuer
 * Eingriff in `gateway-connection.ts` nötig — Backwards-Compat erhalten.
 */
import { gatewayPool } from './gateway-pool.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import type { ConnectionState, HelloMeta } from './gateway-connection';

type Snapshot = {
  state: ConnectionState;
  helloMeta: HelloMeta | null;
};

const POLL_MS = 1000;

class ServerStateMirror {
  /** serverId → snapshot. Reactive via $state. */
  byId = $state<Record<string, Snapshot>>({});
  #timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.#timer) return;
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), POLL_MS);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Manuell triggern (z.B. unmittelbar nach connect/disconnect). */
  refresh(): void {
    const next: Record<string, Snapshot> = {};
    for (const entry of serversStore.servers) {
      const conn = gatewayPool.peek(entry.id);
      if (conn) {
        next[entry.id] = { state: conn.state, helloMeta: conn.helloMeta };
      } else {
        next[entry.id] = { state: 'idle', helloMeta: null };
      }
    }
    this.byId = next;
  }

  /** Snapshot für eine einzelne Connection. */
  get(serverId: string): Snapshot {
    return this.byId[serverId] ?? { state: 'idle', helloMeta: null };
  }
}

export const serverState = new ServerStateMirror();
