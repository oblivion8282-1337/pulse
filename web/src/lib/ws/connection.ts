/**
 * Backwards-Compat-Wrapper für die Pre-Phase-4.2-Singleton-API. Existing
 * Callsites importieren weiterhin `{ gateway }` aus `$lib/ws/connection`,
 * bekommen aber jetzt eine Proxy-Connection die auf die Active-Server-
 * Connection im `gatewayPool` zeigt.
 *
 * Der Wechsel des aktiven Servers passiert über `setActiveGateway(id)` —
 * sobald gerufen, leitet die `gateway`-Methoden alle Calls an die neue
 * Connection. Listener (`gateway.on(...)`-Subscriber) wandern **nicht**
 * mit; Phase 4.3 baut das Migration-Pattern (Re-Subscribe nach Switch).
 *
 * Re-Exports der Domain-Types bleiben unverändert — viele Callsites
 * machen `import type { ChannelPayload } from '$lib/ws/connection'`.
 */

import { gatewayPool } from './gateway-pool.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import type { GatewayConnection, WsListener, ChannelDeletedHook, GuildDeletedHook } from './gateway-connection';

export type { GatewayConnection, WsListener, ChannelDeletedHook, GuildDeletedHook };
export type {
  ServerEvent,
  ClientEvent,
  ChannelPayload,
  GuildPayload,
  ReadyGuild,
} from './handlers/types';

/**
 * Resolved die Active-Server-Connection im Pool. Wird bei jedem
 * Method-Call auf `gateway` erneut aufgerufen — so wirken Server-Switches
 * sofort, ohne dass Caller eine neue Referenz holen müssen.
 */
function _active(): GatewayConnection {
  const id = activeServer.serverId;
  if (!id) {
    throw new Error('gateway: no active server (activeServer.init() not called?)');
  }
  return gatewayPool.for(id);
}

/**
 * Proxy mit identischer Methoden-Surface wie die Pre-4.2 `GatewayConnection`.
 * Jede Methode delegiert an `_active()` — dadurch ist `setActiveGateway(id)`
 * effektiv "swap to other connection". Property-Getter (`state`, `helloMeta`)
 * lesen die aktive Connection.
 */
export const gateway = {
  // Lifecycle
  connect: () => _active().connect(),
  disconnect: () => _active().disconnect(),
  waitForReady: () => _active().waitForReady(),
  // Listener
  on: (l: WsListener) => _active().on(l),
  onChannelDeleted: (h: ChannelDeletedHook) => _active().onChannelDeleted(h),
  onGuildDeleted: (h: GuildDeletedHook) => _active().onGuildDeleted(h),
  // Subscriptions
  subscribe: (cid: string) => _active().subscribe(cid),
  unsubscribe: (cid: string) => _active().unsubscribe(cid),
  gapFill: (cid: string) => _active().gapFill(cid),
  // Outbound
  send: (cid: string, content: string, nonce: string, replyToId?: string | null) =>
    _active().send(cid, content, nonce, replyToId),
  sendVoiceSelfState: (cid: string | null, m: boolean, d: boolean) =>
    _active().sendVoiceSelfState(cid, m, d),
  startWatchParty: (cid: string, url: string) => _active().startWatchParty(cid, url),
  stopWatchParty: (cid: string, pid: string) => _active().stopWatchParty(cid, pid),
  sendWatchControl: (cid: string, pid: string, a: 'play' | 'pause' | 'seek', p: number) =>
    _active().sendWatchControl(cid, pid, a, p),
  changeWatchSource: (cid: string, pid: string, url: string) =>
    _active().changeWatchSource(cid, pid, url),
  sendWatchHeartbeat: (cid: string, pid: string, p: number) =>
    _active().sendWatchHeartbeat(cid, pid, p),
  sendWatchJoin: (cid: string, pid: string) => _active().sendWatchJoin(cid, pid),
  sendWatchLeave: (cid: string, pid: string) => _active().sendWatchLeave(cid, pid),
  sendWatchHandoff: (cid: string, pid: string, target?: string) =>
    _active().sendWatchHandoff(cid, pid, target),
  watchQueueAdd: (cid: string, pid: string, url: string) =>
    _active().watchQueueAdd(cid, pid, url),
  watchQueueRemove: (cid: string, pid: string, itemId: string) =>
    _active().watchQueueRemove(cid, pid, itemId),
  watchQueueMove: (cid: string, pid: string, itemId: string, index: number) =>
    _active().watchQueueMove(cid, pid, itemId, index),
  watchQueueAdvance: (cid: string, pid: string, itemId?: string) =>
    _active().watchQueueAdvance(cid, pid, itemId),
  sendActivity: () => _active().sendActivity(),
  sendTyping: (cid: string) => _active().sendTyping(cid),
  sendPluginOp: (op: string, payload?: Record<string, unknown>) =>
    _active().sendPluginOp(op, payload),
  // State (reaktiv im Sinne von Re-Read pro Zugriff)
  get state() { return _active().state; },
  get helloMeta() { return _active().helloMeta; },
  get serverId() { return _active().serverId; },
};

/**
 * Wechselt die Active-Server-Connection. Effekt: nachfolgende
 * `gateway.*`-Aufrufe gehen an die neue Connection. Listener und
 * Subscriptions wandern NICHT mit — die UI-Schicht (Phase 4.3) muss
 * Component-Listeners onMount neu registrieren.
 */
export function setActiveGateway(serverId: string): void {
  activeServer.set(serverId);
}

/**
 * Resolved die **Cloud**-Connection im Pool (nicht den aktiven Server).
 * Global-Friends Stufe 1: DMs leben in der Cloud, daher müssen DM-WS-Ops
 * (subscribe/unsubscribe/send/typing/gapFill) gegen die Cloud-Connection
 * laufen — sonst ginge ein DM-Send bei aktivem Self-Host an den falschen
 * Server. Wirft, wenn (unerwartet) kein Cloud-Eintrag existiert; `init()`
 * garantiert ihn.
 */
function _cloud(): GatewayConnection {
  const id = serversStore.cloudId();
  if (!id) {
    throw new Error('cloudGateway: no cloud server entry (serversStore.init() not called?)');
  }
  return gatewayPool.for(id);
}

/**
 * Wie `gateway`, aber fest auf die **Cloud**-Connection gepinnt. Nur die für
 * DMs/Social relevante Methoden-Surface — andere Ops (Voice/Watch/Stream)
 * sind aktiv-server-gebunden und gehören NICHT hierher. Die DM/Friends-UI
 * nutzt diesen Accessor statt `gateway`.
 */
export const cloudGateway = {
  connect: () => _cloud().connect(),
  waitForReady: () => _cloud().waitForReady(),
  on: (l: WsListener) => _cloud().on(l),
  subscribe: (cid: string) => _cloud().subscribe(cid),
  unsubscribe: (cid: string) => _cloud().unsubscribe(cid),
  gapFill: (cid: string) => _cloud().gapFill(cid),
  send: (cid: string, content: string, nonce: string, replyToId?: string | null) =>
    _cloud().send(cid, content, nonce, replyToId),
  sendTyping: (cid: string) => _cloud().sendTyping(cid),
  get state() { return _cloud().state; },
  get serverId() { return _cloud().serverId; },
};
