/**
 * Phase 4.5 — Listener-Migration-Helper.
 *
 * Components, die auf WS-Events lauschen wollen, sollen **diesen** Helper
 * verwenden, statt direkt `gateway.on(...)` aus `$lib/ws/connection`. Der
 * `gateway`-Proxy delegiert zwar auf die aktuell aktive Connection, aber:
 *
 *  - `gateway.on(cb)` registriert `cb` auf der **damals**-aktiven Connection
 *    und liefert einen `off()`, der genau diese Connection wieder
 *    deregistriert. Switcht der User auf einen anderen Server, blasst der
 *    Listener bei der alten Connection (irrelevant) und es gibt **keinen**
 *    Listener auf der neuen.
 *
 *  - `useGatewayListener` hängt sich über `$effect` an `activeServer.serverId`
 *    und re-registriert beim Switch automatisch.
 *
 * Verwendung (Svelte-Component):
 *
 *   useGatewayListener((evt) => {
 *     if (evt.op === 'guild_member_updated') { ... }
 *   });
 *
 * Verwendung (mit Channel-/Guild-Deleted-Hooks):
 *
 *   useGatewayDeletedListener({
 *     onChannel: (gid, cid) => { ... },
 *     onGuild: (gid) => { ... },
 *   });
 *
 * **MUSS** im Component-Top-Level (`<script>`) gerufen werden, nicht in
 * `onMount` — `$effect` braucht den Component-Context.
 */

import { activeServer } from '$lib/stores/active-server.svelte';
import { gatewayPool } from './gateway-pool.svelte';
import type {
  WsListener,
  ChannelDeletedHook,
  GuildDeletedHook,
} from './gateway-connection';

/**
 * Registriert `cb` auf der jeweils aktuellen Active-Server-Connection.
 * Wandert beim Server-Switch automatisch mit (alter Listener wird
 * deregistriert, neuer auf der neuen Connection registriert).
 *
 * Cleanup auf Component-Destroy passiert über den `$effect`-Return.
 */
export function useGatewayListener(cb: WsListener): void {
  $effect(() => {
    const id = activeServer.serverId;
    if (!id) return;
    let off: (() => void) | null = null;
    try {
      const conn = gatewayPool.for(id);
      off = conn.on(cb);
    } catch (err) {
      // ServerEntry verschwunden — Pool kann keine Connection bauen.
      // Listener bleibt inaktiv bis zum nächsten Switch.
      console.warn('[useGatewayListener] no pool entry for', id, err);
    }
    return () => {
      if (off) off();
    };
  });
}

/**
 * Variante für die spezial-Hooks `onChannelDeleted` / `onGuildDeleted`.
 * Beide Hooks sind optional; übergib nur was du brauchst.
 */
export function useGatewayDeletedListener(handlers: {
  onChannel?: ChannelDeletedHook;
  onGuild?: GuildDeletedHook;
}): void {
  $effect(() => {
    const id = activeServer.serverId;
    if (!id) return;
    const offs: Array<() => void> = [];
    try {
      const conn = gatewayPool.for(id);
      if (handlers.onChannel) offs.push(conn.onChannelDeleted(handlers.onChannel));
      if (handlers.onGuild) offs.push(conn.onGuildDeleted(handlers.onGuild));
    } catch (err) {
      console.warn('[useGatewayDeletedListener] no pool entry for', id, err);
    }
    return () => {
      for (const off of offs) off();
    };
  });
}
