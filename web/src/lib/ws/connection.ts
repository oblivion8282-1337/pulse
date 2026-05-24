/**
 * Authenticated WebSocket singleton for the chat gateway.
 *
 * - Reconnects with backoff [1s, 2s, 5s, 10s, 30s, 30s...]
 * - Re-subscribes to remembered channels after reconnect
 * - Refreshes the access token before each connect attempt
 * - On a 4001 close (expired/invalid token) forces a token refresh first
 *
 * The op-switch lives in `handlers/*` (Phase 2c of the plugin-system
 * plan). This file owns connection lifecycle, the pre-ready buffer,
 * send helpers and the `gateway.on()` listener fan-out. Adding a new
 * server op = add a variant to `handlers/types.ts` + a handler in the
 * matching domain module; this file stays untouched. Gap-fill +
 * voice-join/leave-sounds live in their own sibling modules
 * (`gapFill.ts`, `voiceDiff.ts`).
 */

import { currentAccessToken } from '$lib/api/client';
import { isAccessExpired, loadTokens } from '$lib/api/storage';
import { guilds } from '$lib/stores/guilds.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { sounds } from '$lib/sounds/engine';
import { dispatch } from './handler-registry';
import { registerAllHandlers } from './handlers';
import { gapFillAll, gapFillChannel } from './gapFill';
import { fireVoiceDiff } from './voiceDiff';
import type { ServerEvent, ClientEvent } from './handlers/types';

// Re-exports so existing import sites (`import type { ChannelPayload } from
// '$lib/ws/connection'`) keep working without ripple changes.
export type {
  ServerEvent,
  ClientEvent,
  ChannelPayload,
  GuildPayload,
  ReadyGuild
} from './handlers/types';

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

// Ops that get held back until `ready` has populated guilds.byId. Every
// other op is safe to dispatch immediately. Listed as the *small* side
// (buffer-9 vs deliver-34) so adding a new safe-to-deliver op is a no-op
// here. Anything that walks `guilds.byId` / `guilds.channelsByGuild`
// needs to be added (channel + guild lifecycle, sound refresh).
const BUFFER_BEFORE_READY: ReadonlySet<ServerEvent['op']> = new Set([
  'channel_created',
  'channel_updated',
  'channel_deleted',
  'channel_bump',
  'dm_bump',
  'guild_updated',
  'guild_deleted',
  'guild_member_added',
  'guild_sound_updated'
]);

export type WsListener = (evt: ServerEvent) => void;
/** Optional hook fired when the channel the user is viewing gets deleted. */
export type ChannelDeletedHook = (guildId: string, channelId: string) => void;
/** Optional hook fired when the guild the user is viewing gets deleted. */
export type GuildDeletedHook = (guildId: string) => void;

export class GatewayConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private subs = new Set<string>();
  private listeners = new Set<WsListener>();
  private channelDeletedHooks = new Set<ChannelDeletedHook>();
  private guildDeletedHooks = new Set<GuildDeletedHook>();
  private wantConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsPath = '/api/ws/ws';
  private connectPromise: Promise<void> | null = null;
  // True until the next connect attempt forces a token refresh — set after a
  // 4001 close so the reconnect uses a fresh credential.
  private forceRefreshNext = false;
  // Buffer for events that arrive before the `ready` handler has run.
  private _readyDone = false;
  private _preReadyBuffer: ServerEvent[] = [];
  // Resolved when the *current* connection's Ready frame has been processed.
  // The /app layout awaits this so it doesn't render with an empty
  // `guilds.byId` between WS-open and Ready arrival. Replaced on each connect.
  private _readyPromise: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;

  constructor() {
    registerAllHandlers(
      {
        subs: this.subs,
        unsubscribe: (cid) => this.unsubscribe(cid),
        fireChannelDeleted: (gid, cid) => {
          for (const h of this.channelDeletedHooks) h(gid, cid);
        },
        fireGuildDeleted: (gid) => {
          for (const h of this.guildDeletedHooks) h(gid);
        },
        fireVoiceDiff
      },
      { onReadySeeded: () => this._finishReady() }
    );
  }

  private _finishReady(): void {
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
    }
    this._readyDone = true;
    // Replay buffered lifecycle events now that guilds.byId is populated.
    for (const buffered of this._preReadyBuffer) void dispatch(buffered);
    this._preReadyBuffer = [];
  }

  on(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChannelDeleted(hook: ChannelDeletedHook): () => void {
    this.channelDeletedHooks.add(hook);
    return () => this.channelDeletedHooks.delete(hook);
  }

  onGuildDeleted(hook: GuildDeletedHook): () => void {
    this.guildDeletedHooks.add(hook);
    return () => this.guildDeletedHooks.delete(hook);
  }

  async connect(): Promise<void> {
    this.wantConnected = true;
    if (this.ws && this.ws.readyState <= 1) return;
    if (this.connectPromise) return this.connectPromise;
    // Fresh Ready promise for this connection. Resolved by the ready
    // handler via `_finishReady`; rejected if the dial fails.
    this._readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
    this.connectPromise = this._dial();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /** Resolves once the Ready frame for the *current* connection has been
   * processed (guilds.byId, roles, voice/stream/watch presence all seeded).
   * The /app layout awaits this before painting so the first frame already
   * has the GuildRail populated. Returns immediately if Ready already came. */
  waitForReady(): Promise<void> {
    if (this._readyDone) return Promise.resolve();
    return this._readyPromise ?? Promise.resolve();
  }

  private async _dial(): Promise<void> {
    if (!loadTokens()) return;
    // Force a refresh if expired, or if a prior 4001 close asked for one.
    if (this.forceRefreshNext || isAccessExpired(currentAccessToken() ?? '')) {
      this.forceRefreshNext = false;
      // Trigger a refresh via the api client. Re-loading the token will
      // pick the new one up.
      const { request } = await import('$lib/api/client');
      try {
        await request<{ id: string }>('/me', { endpoint: 'auth' });
      } catch {
        // Refresh failed — token is dead. Sign out and stop reconnecting.
        if (!loadTokens()) {
          this.wantConnected = false;
          auth.signOut();
        }
        return;
      }
    }
    const token = currentAccessToken();
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}${this.wsPath}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        this.attempt = 0;
        this._readyDone = false;
        this._preReadyBuffer = [];
        // Restore subscriptions on reconnect.
        for (const cid of this.subs) {
          this._sendRaw({ op: 'subscribe', channel_id: cid });
        }
        // Re-emit our voice mute/deafen state. The previous socket's disconnect
        // path cleared ``voice:user_state:<uid>`` server-side (last-socket-gone
        // race on token-expiry close), so peers stopped seeing our icons.
        void import('$lib/voice/livekit.svelte').then(({ voice }) => {
          voice.resyncSelfState();
        });
        // Backfill anything that arrived during the disconnect via REST
        // (`?after=<lastSeenId>`). Done *after* re-subscribing so any new
        // WS-pushed message racing the REST call gets deduped by mergeGap
        // (id + nonce). Token expiry triggers a close every
        // jwt_access_ttl_seconds (=15min); without this the user sees the
        // chat blink on every cycle.
        void gapFillAll(this.subs);
        resolve();
      });
      ws.addEventListener('message', (event) => {
        let evt: ServerEvent;
        try {
          evt = JSON.parse(event.data) as ServerEvent;
        } catch {
          return;
        }
        this._handle(evt);
        for (const l of this.listeners) l(evt);
      });
      ws.addEventListener('close', (event) => {
        this.ws = null;
        // 4001 == token expired/invalid: refresh before the next attempt.
        if (event.code === 4001) this.forceRefreshNext = true;
        if (!opened) reject(new Error('ws closed before open'));
        if (this.wantConnected) this._scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        // Surface as close — browsers fire close right after.
      });
    });
  }

  /** Gap-fill a single channel after (re)subscribing — used by the
   *  channel-switch path. See `gapFill.ts` for details. */
  async gapFill(channelId: string): Promise<void> {
    await gapFillChannel(channelId, true);
  }

  private _handle(evt: ServerEvent): void {
    // Buffer lifecycle events that arrive before `ready` populated guilds.byId.
    if (!this._readyDone && BUFFER_BEFORE_READY.has(evt.op)) {
      this._preReadyBuffer.push(evt);
      return;
    }
    void dispatch(evt);
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, wait);
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subs.clear();
  }

  subscribe(channelId: string): void {
    this.subs.add(channelId);
    this._sendRaw({ op: 'subscribe', channel_id: channelId });
  }

  unsubscribe(channelId: string): void {
    if (!this.subs.delete(channelId)) return;
    this._sendRaw({ op: 'unsubscribe', channel_id: channelId });
  }

  /** Returns true when the frame was queued, false when the socket was not open. */
  send(
    channelId: string,
    content: string,
    nonce: string,
    replyToId?: string | null
  ): boolean {
    const queued = this._sendRaw({
      op: 'send',
      channel_id: channelId,
      content,
      nonce,
      reply_to_id: replyToId ?? null
    });
    if (queued) {
      // DM channel → no guild → falls back to default.
      sounds.play('ui.send', { guildId: guilds.guildIdForChannel(channelId) });
    }
    return queued;
  }

  /** Report mute/deafen state to the gateway → fanned out to every other
   * client. `channelId` is null when clearing on disconnect. */
  sendVoiceSelfState(channelId: string | null, micMuted: boolean, deafened: boolean): boolean {
    return this._sendRaw({
      op: 'voice_self_state',
      channel_id: channelId,
      mic_muted: micMuted,
      deafened: deafened
    });
  }

  /** Kick off a watch party. Server may reject with `{op:'error', code:4013}`
   * (unsupported source) or `4014` (party already active). */
  startWatchParty(channelId: string, sourceUrl: string): boolean {
    return this._sendRaw({ op: 'watch_start', channel_id: channelId, source_url: sourceUrl });
  }
  /** Host-only stop. Server replies with `{op:'watch_state', state:null}`. */
  stopWatchParty(channelId: string): boolean {
    return this._sendRaw({ op: 'watch_stop', channel_id: channelId });
  }
  /** Host-only play/pause/seek. Server broadcasts the resulting `watch_state`. */
  sendWatchControl(
    channelId: string,
    action: 'play' | 'pause' | 'seek',
    position: number
  ): boolean {
    return this._sendRaw({ op: 'watch_control', channel_id: channelId, action, position });
  }
  /** Host heartbeat every ~3s so viewers can correct drift. Server debounces
   * the write to ≤1 / 2s; sending faster is harmless but wasteful. */
  sendWatchHeartbeat(channelId: string, position: number): boolean {
    return this._sendRaw({ op: 'watch_heartbeat', channel_id: channelId, position });
  }

  /** Fire-and-forget activity heartbeat — bumps presence:activity ZSET and
   *  flips `idle` → `online`. No-op when the socket isn't open. */
  sendActivity(): boolean {
    return this._sendRaw({ op: 'activity' });
  }

  /** Generic plugin-op outbound channel.
   *
   *  Lets a Pulse-Plugin push an op-frame that isn't part of the core
   *  `ClientEvent` union — required because plugin op-codes are runtime-
   *  registered (the union can't enumerate them at build time). The op
   *  must be a colon-namespaced string (e.g. ``tamagotchi:feed``); we
   *  refuse bare names so a plugin can't accidentally collide with a
   *  built-in op (``send``, ``subscribe``, …).
   *
   *  Backend permission gate (Schritt 5) verifies that the chat-gateway
   *  has a registered handler for the op — unregistered ops yield a
   *  `code 4007` error frame back to this socket. */
  sendPluginOp(op: string, payload?: Record<string, unknown>): boolean {
    if (!op.includes(':')) {
      console.warn('[ws] sendPluginOp: op must be namespaced (e.g. "plugin:action"), got', op);
      return false;
    }
    // Cast through unknown — the runtime contract is that the gateway
    // accepts any op-frame; the type union is just a build-time guard for
    // core ops. Plugins live outside that union.
    return this._sendRaw({ op, ...(payload ?? {}) } as unknown as ClientEvent);
  }

  private _sendRaw(evt: ClientEvent): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(evt));
      return true;
    }
    return false;
  }
}

export const gateway = new GatewayConnection();
