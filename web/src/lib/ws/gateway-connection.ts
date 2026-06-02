/**
 * Per-Server-WebSocket-Connection — Phase 4.2. `gateway-pool.svelte.ts` hält
 * die Map<serverId, GatewayConnection>; `connection.ts::gateway` proxied auf
 * die aktive Connection. Self-Host: hello-Frame-Check (MIN_SERVER_VERSION) +
 * Close-Code-Mapping 4044/4045/4046 = Reconnect, 4047/4003 = Stop. Bootstrap
 * der globalen handler-registry läuft genau einmal. Multi-Server-Stores =
 * Phase 4.5+ Scope.
 */

import { currentAccessToken } from '$lib/api/client';
import { isAccessExpired, loadTokens } from '$lib/api/storage';
import { sessionTokens } from '$lib/api/session_tokens.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import {
  MIN_SERVER_VERSION,
  RECONNECT_BACKOFF_MS,
  WS_CLOSE,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
} from '$lib/api/constants';
import { guilds } from '$lib/stores/guilds.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { sounds } from '$lib/sounds/engine';
import { dispatch } from './handler-registry';
import { bootstrapHandlersOnce } from './gateway-handlers-bootstrap';
import { gapFillAll, gapFillChannel } from './gapFill';
import * as senders from './gateway-senders';
import type { ServerEvent, ClientEvent } from './handlers/types';

const BUFFER_BEFORE_READY: ReadonlySet<ServerEvent['op']> = new Set([
  'channel_created', 'channel_updated', 'channel_deleted', 'channel_bump', 'dm_bump',
  'guild_updated', 'guild_deleted', 'guild_member_added', 'guild_sound_updated',
]);

export type WsListener = (evt: ServerEvent) => void;
export type ChannelDeletedHook = (guildId: string, channelId: string) => void;
export type GuildDeletedHook = (guildId: string) => void;

/** 4044=incompatible · 4045=updating · 4046=starting · 4047=mfa-required · 4003=cors-blocked */
export type ConnectionState =
  | 'idle' | 'connecting' | 'open' | 'closed'
  | 'incompatible' | 'updating' | 'starting' | 'mfa-required' | 'cors-blocked';

export type HelloMeta = { server_version: string; capabilities: string[] };

export type GatewayConnectionOpts = {
  serverId: string;
  hostname: string;
  isCloud: boolean;
  /** Pfad inkl. führendem Slash. Cloud: '/api/ws/ws', Self-Host: '/ws'. */
  wsPath?: string;
};

/** Re-Auth-Hook für Self-Host. Wird in Phase 4.3 vom Cert-Flow gesetzt. */
let _selfHostReauthHandler: ((serverId: string) => void) | null = null;
export function setSelfHostReauthHandler(fn: ((serverId: string) => void) | null): void {
  _selfHostReauthHandler = fn;
}

/** Die aktuell *dispatchende* Connection. Nur die aktive Connection ruft
 *  `dispatch()` auf (Race-Guard in `_handle`), daher ist sie das korrekte Ziel
 *  für den globalen Handler-Context (subs/unsubscribe/hooks/onReadySeeded).
 *  Vorher hing der Context fest an der zuerst gebauten (Cloud-)Connection →
 *  auf einem aktiven Self-Host-Server gingen pre-ready-Events verloren und
 *  markRead/Delete-Hooks liefen auf der falschen Connection. */
let _dispatchingConn: GatewayConnection | null = null;
const _EMPTY_SUBS = new Set<string>();

/** Semver-Compare. Returns negative/0/positive (a vs b). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d; }
  return 0;
}

export class GatewayConnection {
  readonly serverId: string;
  readonly hostname: string;
  readonly isCloud: boolean;
  private readonly wsPath: string;

  private ws: WebSocket | null = null;
  private attempt = 0;
  private subs = new Set<string>();
  // Watch-party channels this socket has joined (mount = join, unmount =
  // leave). Re-announced on every reconnect — see the `open` handler.
  private watchJoins = new Set<string>();
  private listeners = new Set<WsListener>();
  private channelDeletedHooks = new Set<ChannelDeletedHook>();
  private guildDeletedHooks = new Set<GuildDeletedHook>();
  private wantConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private connectPromise: Promise<void> | null = null;
  private forceRefreshNext = false;
  private _readyDone = false;
  private _preReadyBuffer: ServerEvent[] = [];
  private _readyPromise: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;

  /** Reaktiv: erstes Hello-Frame des Servers (nur Self-Host). */
  helloMeta: HelloMeta | null = null;
  /** Reaktiv: aktueller Connection-State; UI/Banner-Trigger (Phase 4.3). */
  state: ConnectionState = 'idle';

  constructor(opts: GatewayConnectionOpts) {
    this.serverId = opts.serverId;
    this.hostname = opts.hostname;
    this.isCloud = opts.isCloud;
    // Cloud läuft über nginx-Proxy `/api/ws/ws`; Self-Host direkt auf `/ws`.
    this.wsPath = opts.wsPath ?? (opts.isCloud ? '/api/ws/ws' : '/ws');

    // Bind the global handler-context to whichever connection is *currently
    // dispatching* (the active server), not to `this` (the first connection
    // constructed, i.e. cloud). Resolved lazily on every access.
    bootstrapHandlersOnce({
      getSubs: () => _dispatchingConn?.subs ?? _EMPTY_SUBS,
      unsubscribe: (cid) => _dispatchingConn?.unsubscribe(cid),
      fireChannelDeleted: (gid, cid) => {
        if (!_dispatchingConn) return;
        for (const h of _dispatchingConn.channelDeletedHooks) h(gid, cid);
      },
      fireGuildDeleted: (gid) => {
        if (!_dispatchingConn) return;
        for (const h of _dispatchingConn.guildDeletedHooks) h(gid);
      },
      onReadySeeded: () => _dispatchingConn?._finishReady(),
    });
  }

  private _finishReady(): void {
    // The buffered events below are dispatched through the global registry,
    // so make sure the context resolves to *this* connection during the flush.
    _dispatchingConn = this;
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
    }
    this._readyDone = true;
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
    this._readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
    this.connectPromise = this._dial();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
      // Wenn _dial entweder failed (throw: 'ws closed before open', token-
      // expired etc.) oder ohne ready-Frame in den 'closed'-State geht,
      // muss waitForReady() trotzdem entlassen werden — sonst hängt der
      // Layout-Mount im Promise.all forever und der User sieht ewig
      // 'loading…'. Self-Host: der reauth-Handler triggert später einen
      // erneuten connect(); Cloud: refresh-Token-Pfad rufts wieder auf.
      if (!this._readyDone && this._readyResolve) {
        this._readyResolve();
        this._readyResolve = null;
      }
    }
  }

  waitForReady(): Promise<void> {
    if (this._readyDone) return Promise.resolve();
    return this._readyPromise ?? Promise.resolve();
  }

  /** Cloud → JWT mit Refresh; Self-Host → sessionTokens (kein Refresh, Cert-Re-Auth Phase 4.3). */
  private async _resolveToken(): Promise<string | null> {
    if (this.isCloud) {
      if (this.forceRefreshNext || isAccessExpired(currentAccessToken() ?? '')) {
        this.forceRefreshNext = false;
        const { request } = await import('$lib/api/client');
        try {
          await request<{ id: string }>('/me', { endpoint: 'auth' });
        } catch {
          if (!loadTokens()) {
            this.wantConnected = false;
            auth.signOut();
          }
          return null;
        }
      }
      return currentAccessToken();
    }
    // Self-Host
    const entry = sessionTokens.get(this.serverId);
    if (!entry || Date.now() >= entry.expiresAt) {
      if (_selfHostReauthHandler) _selfHostReauthHandler(this.serverId);
      return null;
    }
    return entry.token;
  }

  /** Cloud: window.location.host (nginx-Proxy). Self-Host: Hostname direkt. */
  private _wsUrl(token: string): string {
    if (this.isCloud) {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${window.location.host}${this.wsPath}?token=${encodeURIComponent(token)}`;
    }
    // Self-Host: https://host → wss://host
    const httpsHost = this.hostname.replace(/^https?:\/\//, '');
    return `wss://${httpsHost}${this.wsPath}?token=${encodeURIComponent(token)}`;
  }

  private async _dial(): Promise<void> {
    this.state = 'connecting';
    if (this.isCloud && !loadTokens()) {
      this.state = 'closed';
      return;
    }
    const token = await this._resolveToken();
    if (!token) {
      this.state = 'closed';
      return;
    }
    const ws = new WebSocket(this._wsUrl(token));
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let opened = false;
      let firstFrame = true; // Cloud + Self-Host senden hello (Phase 3.3 für beide)
      ws.addEventListener('open', () => {
        opened = true;
        this.state = 'open';
        this.attempt = 0;
        this._readyDone = false;
        this._preReadyBuffer = [];
        for (const cid of this.subs) {
          this._sendRaw({ op: 'subscribe', channel_id: cid });
        }
        // Re-announce watch-party membership. A transparent reconnect drops
        // the old socket; the server then starts a WATCH_HOST_GRACE_S timer
        // that ends the party unless the host rejoins. The mounted tile never
        // re-fires onMount across a reconnect, so without this the party dies
        // ~30s after any blip. Mirrors the voice resync below.
        for (const cid of this.watchJoins) {
          this._sendRaw({ op: 'watch_join', channel_id: cid });
        }
        void import('$lib/voice/livekit.svelte').then(({ voice }) => {
          voice.resyncSelfState();
        });
        void gapFillAll(this.subs);
        this._startHeartbeat();
        resolve();
      });
      ws.addEventListener('message', (event) => {
        let evt: ServerEvent;
        try {
          evt = JSON.parse(event.data) as ServerEvent;
        } catch {
          return;
        }
        // Keepalive reply — record liveness and swallow it before the
        // firstFrame/handler path so it never reaches the dispatch registry
        // (which would log it as an unknown op). `pong` is never the first
        // frame: it only arrives in response to a ping we send ≥25s post-open.
        if ((evt as unknown as { op: string }).op === 'pong') {
          this.lastPongAt = Date.now();
          return;
        }
        if (firstFrame) {
          firstFrame = false;
          if ((evt as unknown as { op: string }).op === 'hello') {
            const hello = evt as unknown as HelloMeta & { op: 'hello' };
            this.helloMeta = {
              server_version: hello.server_version,
              capabilities: hello.capabilities ?? [],
            };
            if (compareVersions(hello.server_version, MIN_SERVER_VERSION) < 0) {
              this.state = 'incompatible';
              try { ws.close(WS_CLOSE.SERVER_TOO_OLD, 'server too old'); } catch { /* noop */ }
              return;
            }
            return; // Hello selbst geht NICHT in den Handler-Dispatcher
          }
          // Fallback: älterer Server ohne hello-Support → durchlassen.
        }
        this._handle(evt);
        for (const l of this.listeners) l(evt);
      });
      ws.addEventListener('close', (event) => {
        this.ws = null;
        this._stopHeartbeat();
        this._mapCloseCode(event.code);
        // Reject the _dial promise if the socket never opened, then fall
        // through to schedule a reconnect regardless (wantConnected check
        // below). These two paths are intentionally not mutually exclusive:
        // we want the promise to reject *and* a retry to be scheduled.
        if (!opened) reject(new Error('ws closed before open'));
        if (this.wantConnected) this._scheduleReconnect();
      });
      ws.addEventListener('error', () => { /* Browser feuert direkt close. */ });
    });
  }

  private _mapCloseCode(code: number): void {
    switch (code) {
      case WS_CLOSE.TOKEN_EXPIRED: this.forceRefreshNext = true; this.state = 'closed'; return;
      case WS_CLOSE.SERVER_TOO_OLD: this.state = 'incompatible'; return;
      case WS_CLOSE.SERVER_UPDATING: this.state = 'updating'; return;
      case WS_CLOSE.JWKS_NOT_READY: this.state = 'starting'; return;
      case WS_CLOSE.MFA_REQUIRED: this.state = 'mfa-required'; this.wantConnected = false; return;
      case WS_CLOSE.CORS_BLOCKED: this.state = 'cors-blocked'; this.wantConnected = false; return;
      default: this.state = 'closed';
    }
  }

  async gapFill(channelId: string): Promise<void> {
    await gapFillChannel(channelId, true);
  }

  private _handle(evt: ServerEvent): void {
    if (!this._readyDone && BUFFER_BEFORE_READY.has(evt.op)) {
      this._preReadyBuffer.push(evt);
      return;
    }
    // Race-Guard (Phase 4.5+): wenn dieser Server nicht mehr der aktive ist,
    // skip die globalen Store-Handler. Beispiel-Szenario: User wechselt von
    // A→B, A's Connection reconnectet danach und schickt einen ready-Frame —
    // ohne Guard würde der die B-Stores mit A-Daten überschreiben.
    // Per-Connection-Listener (useGatewayListener) sind davon unberührt;
    // die werden bei A→B-Switch automatisch von $effect deregistriert.
    if (this.serverId !== activeServer.serverId) return;
    // Mark this as the dispatching connection so the global handler-context
    // (subs/unsubscribe/hooks/onReadySeeded) resolves to it, not to cloud.
    _dispatchingConn = this;
    void dispatch(evt);
  }

  /** Start the keepalive once a socket opens. Sends a ping every
   *  WS_PING_INTERVAL_MS; if no pong has arrived within WS_PONG_TIMEOUT_MS
   *  the connection is half-open (silent TCP drop, no close event) — force a
   *  `ws.close()` so the existing close→reconnect path fires. */
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => this._heartbeatTick(), WS_PING_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _heartbeatTick(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPongAt > WS_PONG_TIMEOUT_MS) {
      // Dead/half-open: closing surfaces the `close` event the dropped TCP
      // never delivered, which schedules a reconnect (wantConnected stays
      // true). Stop ticking now; the close handler also calls _stopHeartbeat.
      this._stopHeartbeat();
      try { ws.close(); } catch { /* already closing */ }
      return;
    }
    this._sendRaw({ op: 'ping' });
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const wait =
      RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, wait);
  }

  disconnect(): void {
    this.wantConnected = false;
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subs.clear();
    this.watchJoins.clear();
    this.state = 'idle';
  }

  subscribe(channelId: string): void {
    this.subs.add(channelId);
    this._sendRaw({ op: 'subscribe', channel_id: channelId });
  }

  unsubscribe(channelId: string): void {
    if (!this.subs.delete(channelId)) return;
    this._sendRaw({ op: 'unsubscribe', channel_id: channelId });
  }

  send(channelId: string, content: string, nonce: string, replyToId?: string | null): boolean {
    const queued = this._sendRaw({
      op: 'send', channel_id: channelId, content, nonce, reply_to_id: replyToId ?? null,
    });
    if (queued) sounds.play('ui.send', { guildId: guilds.guildIdForChannel(channelId) });
    return queued;
  }

  sendVoiceSelfState = (channelId: string | null, micMuted: boolean, deafened: boolean): boolean =>
    senders.sendVoiceSelfState(this._raw, channelId, micMuted, deafened);
  startWatchParty = (channelId: string, sourceUrl: string): boolean =>
    senders.startWatchParty(this._raw, channelId, sourceUrl);
  stopWatchParty = (channelId: string): boolean => senders.stopWatchParty(this._raw, channelId);
  sendWatchControl = (channelId: string, action: 'play' | 'pause' | 'seek', position: number): boolean =>
    senders.sendWatchControl(this._raw, channelId, action, position);
  sendWatchHeartbeat = (channelId: string, position: number): boolean =>
    senders.sendWatchHeartbeat(this._raw, channelId, position);
  sendWatchJoin = (channelId: string): boolean => {
    this.watchJoins.add(channelId);
    return senders.sendWatchJoin(this._raw, channelId);
  };
  sendWatchLeave = (channelId: string): boolean => {
    this.watchJoins.delete(channelId);
    return senders.sendWatchLeave(this._raw, channelId);
  };
  sendWatchHandoff = (channelId: string, targetUserId?: string): boolean =>
    senders.sendWatchHandoff(this._raw, channelId, targetUserId);
  sendActivity(): boolean { return this._sendRaw({ op: 'activity' }); }
  sendPluginOp = (op: string, payload?: Record<string, unknown>): boolean =>
    senders.sendPluginOp(this._raw, op, payload);

  private _raw = (evt: ClientEvent): boolean => this._sendRaw(evt);

  private _sendRaw(evt: ClientEvent): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(evt));
      return true;
    }
    return false;
  }
}
