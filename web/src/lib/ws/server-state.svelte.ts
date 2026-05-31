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
  /** Non-reactive shadow of the last published `byId`, used purely for change
   *  detection. Diffing against the reactive `byId` proxy would compare a
   *  proxied `helloMeta` against the raw `conn.helloMeta` (different
   *  identities) → state_proxy_equality_mismatch warning every poll *and* a
   *  false "changed", which reassigned `byId` 1×/s in steady state. Compare
   *  raw-vs-raw here instead. */
  #last: Record<string, Snapshot> = {};
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
    let changed = false;
    for (const entry of serversStore.servers) {
      const conn = gatewayPool.peek(entry.id);
      const snapshot: Snapshot = conn
        ? { state: conn.state, helloMeta: conn.helloMeta }
        : { state: 'idle', helloMeta: null };
      next[entry.id] = snapshot;

      const prev = this.#last[entry.id];
      if (!prev || prev.state !== snapshot.state || prev.helloMeta !== snapshot.helloMeta) {
        changed = true;
      }
    }
    // Server removed since last poll? Key count shrank → publish the new set.
    if (!changed && Object.keys(next).length !== Object.keys(this.#last).length) {
      changed = true;
    }

    // Only reassign if something actually changed, avoiding reactive diffing on steady-state.
    if (changed) {
      this.#last = next;
      this.byId = next;
    }
  }

  /** Snapshot für eine einzelne Connection. */
  get(serverId: string): Snapshot {
    return this.byId[serverId] ?? { state: 'idle', helloMeta: null };
  }
}

export const serverState = new ServerStateMirror();
