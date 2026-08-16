/**
 * Per-Server-WebSocket-Connection — Phase 4.2. `gateway-pool.svelte.ts` hält
 * die Map<serverId, GatewayConnection>; `connection.ts::gateway` proxied auf
 * die aktive Connection. Self-Host: hello-Frame-Check (MIN_SERVER_VERSION) +
 * Close-Code-Mapping 4044/4045/4046 = Reconnect, 4047/4003 = Stop. Bootstrap
 * der globalen handler-registry läuft genau einmal. Multi-Server-Stores =
 * Phase 4.5+ Scope.
 */

import { getDirectConnectionDetailed } from '$lib/direct/registry';
import { DirectWebSocket } from '$lib/direct/websocket';
import { isDirectOnly } from '$lib/direct/policy';
import { DirectUnavailableError } from '$lib/direct/transport';
import { serversStore } from '$lib/api/servers.svelte';
import { directStatus } from '$lib/stores/directStatus.svelte';
import { currentAccessToken, request } from '$lib/api/client';
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
import {
  backgroundEligible,
  geraeteEligible,
  istGeraetAuf,
  remoteSessionEligible,
} from './dispatch-rules';
import * as senders from './gateway-senders';
import { compareVersions } from '$lib/utils/semver';
import type { ServerEvent, ClientEvent, RemoteSignalKind } from './handlers/types';

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
  /** Snowflake der Self-Host-Instanz — Voraussetzung für den Direktpfad. */
  instanceId?: string | null;
};

/** Was diese Klasse von einem Socket braucht. Ein echtes `WebSocket` erfüllt
 *  das ebenso wie `DirectWebSocket` (DataChannel-Fassade des Direktpfads);
 *  die Konstanten OPEN/CLOSED sind bei beiden identisch nummeriert. */
type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', fn: (ev: Event) => void): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
  addEventListener(type: 'close', fn: (ev: CloseEvent) => void): void;
  addEventListener(type: 'error', fn: (ev: Event) => void): void;
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

/** Die `serverId` der gerade dispatchenden Connection. Social-Handler, die
 *  jetzt auch Cloud-Background-Events bekommen (dm_bump/message/presence in
 *  DMs), müssen ihr "me" gegen DIESE Connection auflösen, nicht gegen den
 *  aktiven Server: bei aktivem Self-Host kommt ein Cloud-DM-Bump über die
 *  Cloud-Connection rein → "me" ist die Cloud-User-ID, nicht die Self-Host-ID.
 *  Da Dispatch synchron ist (`_dispatchingConn = this` direkt vor `dispatch()`)
 *  und die betroffenen Handler ihr "me" VOR jedem `await` lesen, ist das
 *  race-frei. Für Guild-/Voice-Ops (aktiv-only) == aktive Connection → keine
 *  Verhaltensänderung. */
export function dispatchingServerId(): string | null {
  return _dispatchingConn?.serverId ?? null;
}

/** True, wenn das gerade dispatchende Event von der CLOUD-Connection kommt.
 *  Nutzt der Presence-Handler, um Cloud-Freundes-Präsenz (global, überlebt
 *  Server-Wechsel) vom aktiven Server-Mitglieder-Set zu trennen. */
export function dispatchingIsCloud(): boolean {
  return _dispatchingConn?.isCloud ?? false;
}

/** Lokale (nicht-Wire) Stempel, die `_handle` aufs ready-Event setzt. Beim
 *  Cachen entfernen, damit ein späterer Replay sie aus der *dann*-aktuellen
 *  Wahrheit neu ableitet, nie aus einem veralteten Stempel. */
export type ReadyStamps = { _isActive?: boolean; _isCloud?: boolean; _serverId?: string };
function stripReadyStamps(evt: ServerEvent): ServerEvent {
  const { _isActive: _i1, _isCloud: _i2, _serverId: _i3, ...rest } = evt as ServerEvent & ReadyStamps;
  return rest as ServerEvent;
}

export class GatewayConnection {
  readonly serverId: string;
  readonly hostname: string;
  readonly isCloud: boolean;
  private readonly wsPath: string;
  private readonly instanceId: string | null;

  private ws: SocketLike | null = null;
  private attempt = 0;
  private subs = new Set<string>();
  // Watch-party channels this socket has joined (mount = join, unmount =
  // leave). Re-announced on every reconnect — see the `open` handler.
  private watchJoins = new Set<string>();
  private listeners = new Set<WsListener>();
  private channelDeletedHooks = new Set<ChannelDeletedHook>();
  private guildDeletedHooks = new Set<GuildDeletedHook>();
  private closeHooks = new Set<() => void>();
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
  /** Letzter empfangener (roher) `ready`-Frame dieser Connection. Gecached für
   *  den Server-Switch-Replay: `connect()` returnt früh, wenn die Connection
   *  schon offen ist (`readyState <= 1`) → es kommt KEIN neuer ready, der den
   *  geleerten Server-Teil (guilds/voice/…) neu seedet. `replayReadyForActivation()`
   *  re-dispatcht diesen Cache mit `_isActive=true`. */
  private _lastReadyEvent: ServerEvent | null = null;

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
    this.instanceId = opts.instanceId ?? null;

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
    // Replay the pre-ready buffer — but apply the SAME dispatch rule as
    // `_handle`: a non-active Cloud-Background-Connection may only flush its
    // background-eligible ops (e.g. a buffered DM `dm_bump`), never its
    // buffered guild events (those would overwrite the *active* server's
    // stores). The active connection flushes everything it buffered.
    const isActive = this.serverId === activeServer.serverId;
    for (const buffered of this._preReadyBuffer) {
      if (isActive || (this.isCloud && backgroundEligible(buffered))) {
        void dispatch(buffered);
      }
    }
    this._preReadyBuffer = [];
  }

  /**
   * Server-Switch-Replay (Global-Friends Stufe 1, Option B). Beim Switch ZU
   * dieser (bereits offenen, `_readyDone`) Connection returnt `connect()` früh
   * → es kommt KEIN neuer ready-Frame, der den von `resetServerScopedStores()`
   * geleerten Server-Teil (guilds/voice/stream/watch/roles/sounds/clock) neu
   * seedet. Hier re-dispatchen wir den gecachten letzten ready-Frame mit
   * `_isActive=true`, sodass der ready-Handler den Server-Teil neu anwendet.
   *
   * - **Reiner In-Memory-Replay** — KEIN `ws.close()`, KEIN reconnect, KEIN
   *   Timer. Damit gibt es per Konstruktion keine Reconnect-Race und die
   *   Hintergrund-Cloud-Connection (falls != this) bleibt unangetastet.
   * - `_isCloud`/`_serverId` aus dieser Connection; der ready-Handler ignoriert
   *   den Social-Teil weiterhin, wenn `!isCloud` (Self-Host). Ist `this` die
   *   Cloud, läuft der Social-Seed mit (idempotent).
   *
   * Returns `true`, wenn ein Replay lief; `false`, wenn (noch) kein ready
   * gecached ist → der Caller muss auf den normalen `connect()`/ready-Pfad
   * vertrauen (frische Connection liefert ohnehin einen echten ready).
   */
  replayReadyForActivation(): boolean {
    if (!this._readyDone || !this._lastReadyEvent) return false;
    const evt = stripReadyStamps(this._lastReadyEvent) as ServerEvent & ReadyStamps;
    evt._isActive = true;
    evt._isCloud = this.isCloud;
    evt._serverId = this.serverId;
    _dispatchingConn = this;
    void dispatch(evt);
    return true;
  }

  /**
   * Server-Switch-Refresh (Ergänzung zu `replayReadyForActivation`). Der
   * Replay seedet aus dem gecachten `_lastReadyEvent` — das ist der Stand vom
   * Connect-Zeitpunkt. Live-Events (voice_state/stream/watch) seit dem Connect
   * mutieren die Stores, NICHT den Cache; und während diese Connection im
   * Hintergrund lag (anderer Server aktiv), wurden ihre Live-Events verworfen.
   * Folge: Wer nach dem Connect einem Voice-Channel beigetreten ist, fehlt im
   * stale Replay. Darum hier zusätzlich einen frischen ready vom Server
   * anfordern; der landet via `_handle` im Cache UND seedet die Stores neu.
   *
   * No-op, wenn der Socket (noch) nicht offen/ready ist — dann liefert der
   * normale `connect()`/ready-Pfad ohnehin einen echten ready.
   */
  requestResync(): void {
    if (this._readyDone) this._sendRaw({ op: 'resync' });
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

  /**
   * Der Socket ist zu — auch bei einem transparenten Reconnect und beim
   * absichtlichen `disconnect()`.
   *
   * Für alles, was einen Abriss SOFORT erfahren muss, statt ihn im Takt
   * abzufragen: ein Zeitgeber wird in einem verdeckten oder minimierten Fenster
   * von Chromium gedrosselt (≥1/min), Ereignisse nicht. Die Fernsteuerung hängt
   * daran (`remote/wachten.ts`) — dort ist „Verbindung weg" gleichbedeutend mit
   * „der Gateway hat die Sitzung längst beendet", und genau der Fall tritt ein,
   * während der Host im Vollbild spielt.
   */
  onClose(hook: () => void): () => void {
    this.closeHooks.add(hook);
    return () => this.closeHooks.delete(hook);
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

  /** Direktpfad bevorzugen (WebRTC-DataChannel), sonst normales WebSocket.
   *
   *  Direct-only (App-Host, origin='app_host'): KEIN Relay-WebSocket mehr —
   *  scheitert der Direktpfad, wirft das hier einen DirectUnavailableError;
   *  _dial setzt den State auf 'closed' (= bestehende Offline-Anzeige) und
   *  plant den Backoff-Retry. VPS-Server fallen wie bisher auf ihr normales
   *  WebSocket gegen den Hostname zurück. */
  private async _openSocket(token: string): Promise<SocketLike> {
    if (!this.isCloud && this.instanceId) {
      const result = await getDirectConnectionDetailed(this.instanceId).catch(() => null);
      if (result?.ok && result.conn.isOpen) {
        directStatus.clear(this.instanceId);
        return new DirectWebSocket(result.conn, `${this.wsPath}?token=${encodeURIComponent(token)}`);
      }
      const entry = serversStore.find(this.serverId);
      if (isDirectOnly(entry)) {
        const reason = result && !result.ok ? result.reason : 'ice-failed';
        directStatus.report(this.instanceId, reason);
        throw new DirectUnavailableError(reason);
      }
    }
    return new WebSocket(this._wsUrl(token));
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
    let ws: SocketLike;
    try {
      ws = await this._openSocket(token);
    } catch (e) {
      // Direct-only ohne Direktverbindung: kein Relay-Versuch. 'closed' +
      // Backoff-Retry — die Registry merkt sich den Fehlschlag 60s, der
      // Retry ist also billig, bis der Server wieder erreichbar ist.
      this.state = 'closed';
      if (this.wantConnected) this._scheduleReconnect();
      throw e;
    }
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
        // F19: Cloud-signiertes Profile-Statement pushen, damit der Server (v.a.
        // Self-Hosts) unseren Anzeige-Namen cachen kann (CachedUserProfile) —
        // sonst zeigt die Member-Liste/Voice-Kachel nur die rohe user-<id>.
        // Best-effort; dyn. Import vermeidet einen Import-Zyklus.
        void import('$lib/identity/profile-statement.svelte').then(({ profileStatementStore }) => {
          const raw = profileStatementStore.statement?.raw;
          if (raw && this.ws === ws) this._sendRaw({ op: 'profile_statement', jwt: raw });
        });
        // Re-announce watch-party membership. A transparent reconnect drops
        // the old socket; the server then starts a WATCH_HOST_GRACE_S timer
        // that ends the party unless the host rejoins. The mounted tile never
        // re-fires onMount across a reconnect, so without this the party dies
        // ~30s after any blip. Mirrors the voice resync below.
        for (const joined of this.watchJoins) {
          const [cid, pid] = joined.split(' ');
          this._sendRaw({ op: 'watch_join', channel_id: cid, party_id: pid });
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
        // Vor jeder Zustands-Abbildung und vor dem Reconnect: die Hörer sollen
        // den Abriss erfahren, egal ob danach neu gewählt wird oder nicht.
        // Kopie, weil ein Hörer sich im Ruf abmelden darf.
        for (const h of [...this.closeHooks]) h();
        // Only map the close code (and potentially overwrite the state) when
        // the disconnect was NOT intentional. disconnect() already sets state
        // to 'idle' synchronously before ws.close(); letting _mapCloseCode run
        // afterwards would overwrite that with 'closed' (or another code-
        // derived value), leaving the state wrong after a clean disconnect.
        if (this.wantConnected) this._mapCloseCode(event.code);
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

  /** Public gap-fill trigger. Passes `force=true` to bypass the debounce /
   *  already-in-progress guard in `gapFillChannel`, so callers always get a
   *  fresh fetch regardless of the channel's recent request state. */
  async gapFill(channelId: string): Promise<void> {
    await gapFillChannel(channelId, true);
  }

  private _handle(evt: ServerEvent): void {
    // Cache the raw `ready` for the server-switch replay (see _lastReadyEvent).
    // Store a stamp-free shallow clone so a later replay re-derives the
    // active/cloud flags from the *then*-current truth, never a stale stamp.
    if (evt.op === 'ready') this._lastReadyEvent = stripReadyStamps(evt);
    if (!this._readyDone && BUFFER_BEFORE_READY.has(evt.op)) {
      this._preReadyBuffer.push(evt);
      return;
    }
    // Race-Guard (Phase 4.5+): grundsätzlich dispatcht nur die **aktive**
    // Connection. Beispiel-Szenario: User wechselt von A→B, A's Connection
    // reconnectet danach und schickt einen ready-Frame — ohne Guard würde der
    // die B-Stores mit A-Daten überschreiben. Per-Connection-Listener
    // (useGatewayListener) sind davon unberührt; die werden bei A→B-Switch
    // automatisch von $effect deregistriert.
    //
    // Global-Friends Stufe 1: die **Cloud**-Connection darf eine definierte
    // Op-Allowlist (`backgroundEligible`: Freunde/DMs/Friend-Requests/Blocks/
    // Freund-Presence) AUCH im Hintergrund dispatchen, damit die globale
    // Social-Schicht live bleibt, während ein Self-Host aktiv ist.
    const isActive = this.serverId === activeServer.serverId;
    if (!isActive) {
      // `ready` ist die Ausnahme zur Allowlist: die Cloud-Background-Connection
      // MUSS ihren ready-Frame dispatchen, weil er die globalen Social-Stores
      // seedet (friends/dm_channels/friend_requests/blocks/eigener Status). Der
      // ready-Handler wendet dann via `_isActive`/`_isCloud` nur den Social-
      // Teil an, nie den Server-Teil. Alles andere bleibt auf die
      // `backgroundEligible`-Allowlist beschränkt.
      //
      // Zweite Ausnahme: die Frames einer laufenden Fernsteuerungs-Sitzung auf
      // GENAU deren Verbindung (`remoteSessionEligible`) — sonst endet eine
      // Sitzung nach einem Community-Wechsel nicht mehr sauber (Begründung in
      // `dispatch-rules.ts`). Gilt für Cloud und Self-Host gleichermaßen: eine
      // Fernsteuerung läuft auf dem Server, auf dem sie zustande kam.
      //
      // Dritte Ausnahme: eine Verbindung, auf der dieser Rechner als
      // Standplatz-Gerät eingetragen ist (`geraeteEligible`). Deren `ready`
      // gehört ebenfalls durchgelassen — daran hängt die Geräte-Anmeldung
      // (`handlers/ready.ts`), und ohne sie stünde ein unbeaufsichtigter
      // Rechner für alle anderen auf „offline", sobald sein Fenster gerade eine
      // andere Community zeigt. Der ready-Handler wendet über `_isActive` nur
      // den server-unabhängigen Teil an, überschreibt also keine Stores.
      const allowed =
        evt.op === 'ready'
          ? this.isCloud || istGeraetAuf(this.serverId)
          : remoteSessionEligible(this, evt) ||
            geraeteEligible(this, evt) ||
            (this.isCloud && backgroundEligible(evt));
      if (!allowed) return;
    }
    // Mark this as the dispatching connection so the global handler-context
    // (subs/unsubscribe/hooks/onReadySeeded) + die social-„me"-Auflösung
    // (dispatchingServerId) auf diese Connection zeigen, nicht auf cloud.
    _dispatchingConn = this;
    // ready-Split: dem ready-Handler synchron mitgeben, ob DIESE Connection
    // aktiv und/oder Cloud ist. Server-Teil läuft nur bei aktiv, Social-Teil
    // nur bei Cloud (Cloud==aktiv → beides, heutiges Verhalten). Non-Wire-
    // Felder, vom Server nie gesendet — nur lokal gestempelt.
    if (evt.op === 'ready') {
      const r = evt as ServerEvent & { _isActive?: boolean; _isCloud?: boolean; _serverId?: string };
      r._isActive = isActive;
      r._isCloud = this.isCloud;
      r._serverId = this.serverId;
    }
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
  stopWatchParty = (channelId: string, partyId: string): boolean =>
    senders.stopWatchParty(this._raw, channelId, partyId);
  sendWatchControl = (
    channelId: string, partyId: string, action: 'play' | 'pause' | 'seek', position: number,
    sourceEpoch?: number
  ): boolean =>
    senders.sendWatchControl(this._raw, channelId, partyId, action, position, sourceEpoch);
  changeWatchSource = (channelId: string, partyId: string, sourceUrl: string): boolean =>
    senders.changeWatchSource(this._raw, channelId, partyId, sourceUrl);
  sendWatchHeartbeat = (
    channelId: string, partyId: string, position: number, sourceEpoch?: number
  ): boolean =>
    senders.sendWatchHeartbeat(this._raw, channelId, partyId, position, sourceEpoch);
  sendWatchJoin = (channelId: string, partyId: string): boolean => {
    this.watchJoins.add(`${channelId} ${partyId}`);
    return senders.sendWatchJoin(this._raw, channelId, partyId);
  };
  sendWatchLeave = (channelId: string, partyId: string): boolean => {
    this.watchJoins.delete(`${channelId} ${partyId}`);
    return senders.sendWatchLeave(this._raw, channelId, partyId);
  };
  sendWatchHandoff = (channelId: string, partyId: string, targetUserId?: string): boolean =>
    senders.sendWatchHandoff(this._raw, channelId, partyId, targetUserId);
  watchQueueAdd = (channelId: string, partyId: string, sourceUrl: string): boolean =>
    senders.watchQueueAdd(this._raw, channelId, partyId, sourceUrl);
  watchQueueRemove = (channelId: string, partyId: string, itemId: string): boolean =>
    senders.watchQueueRemove(this._raw, channelId, partyId, itemId);
  watchQueueMove = (channelId: string, partyId: string, itemId: string, index: number): boolean =>
    senders.watchQueueMove(this._raw, channelId, partyId, itemId, index);
  watchQueueAdvance = (channelId: string, partyId: string, itemId?: string): boolean =>
    senders.watchQueueAdvance(this._raw, channelId, partyId, itemId);
  sendActivity(): boolean { return this._sendRaw({ op: 'activity' }); }
  /** Ephemeral "I'm typing" signal for a text channel / DM. Fire-and-forget;
   *  the caller (composer) debounces so this isn't sent on every keystroke. */
  sendTyping(channelId: string): boolean { return this._sendRaw({ op: 'typing', channel_id: channelId }); }
  sendPluginOp = (op: string, payload?: Record<string, unknown>): boolean =>
    senders.sendPluginOp(this._raw, op, payload);

  // Fernsteuerung (remote control) — Consent-Handshake.
  sendRemoteRequest = (channelId: string, hostUserId: string, deviceId?: string | null): boolean =>
    senders.sendRemoteRequest(this._raw, channelId, hostUserId, deviceId);
  sendRemoteRespond = (sessionId: string, accept: boolean): boolean =>
    senders.sendRemoteRespond(this._raw, sessionId, accept);
  sendRemoteEnd = (sessionId: string): boolean =>
    senders.sendRemoteEnd(this._raw, sessionId);
  sendRemoteInput = (sessionId: string, slot: number, frames: string[]): boolean =>
    senders.sendRemoteInput(this._raw, sessionId, slot, frames);
  sendRemoteSignal = (
    sessionId: string, kind: RemoteSignalKind, data: unknown,
  ): boolean => senders.sendRemoteSignal(this._raw, sessionId, kind, data);

  sendDeviceAnnounce = (
    deviceId: string,
    monitors: { index: number; name: string; primary: boolean }[] = [],
  ): boolean => senders.sendDeviceAnnounce(this._raw, deviceId, monitors);

  sendDeviceStreams = (deviceId: string, slots: number[]): boolean =>
    senders.sendDeviceStreams(this._raw, deviceId, slots);

  sendDeviceWithdraw = (deviceId: string): boolean =>
    senders.sendDeviceWithdraw(this._raw, deviceId);

  sendDeviceWake = (deviceId: string, monitor?: number): boolean =>
    senders.sendDeviceWake(this._raw, deviceId, monitor);

  private _raw = (evt: ClientEvent): boolean => this._sendRaw(evt);

  private _sendRaw(evt: ClientEvent): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(evt));
      return true;
    }
    return false;
  }
}
