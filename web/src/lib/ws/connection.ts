/**
 * Authenticated WebSocket singleton for the chat gateway.
 *
 * - Reconnects with backoff [1s, 2s, 5s, 10s, 30s, 30s...]
 * - Re-subscribes to remembered channels after reconnect
 * - Refreshes the access token before each connect attempt
 * - On a 4001 close (expired/invalid token) forces a token refresh first
 */

import { currentAccessToken } from '$lib/api/client';
import { isAccessExpired, loadTokens } from '$lib/api/storage';
import { messages } from '$lib/stores/messages.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { auth } from '$lib/stores/auth.svelte';
import {
  voicePresence,
  type UserVoiceState,
  type VoiceChannelState
} from '$lib/stores/voicePresence.svelte';
import { streamPresence, type StreamChannelState } from '$lib/stores/streamPresence.svelte';
import { streamChat, type StreamChatMessage } from '$lib/stores/streamChat.svelte';
import { readState } from '$lib/stores/readState.svelte';
import type { Message } from '$lib/api/types';

export type ChannelPayload = {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position: number;
  topic: string | null;
  created_at?: string;
};

export type GuildPayload = {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
};

type ReactionEvent = {
  message_id: string;
  channel_id: string;
  user_id: string;
  emoji: string;
};

type ServerEvent =
  | {
      op: 'ready';
      user_id: string;
      guilds: { id: string; name: string }[];
      voice_states?: VoiceChannelState[];
      stream_states?: StreamChannelState[];
    }
  | { op: 'message'; data: Message }
  | { op: 'message_update'; data: Message }
  | { op: 'message_delete'; data: { id: string; channel_id: string } }
  | { op: 'reaction_add'; data: ReactionEvent }
  | { op: 'reaction_remove'; data: ReactionEvent }
  | { op: 'message_ack'; nonce: string | null; id: string }
  | { op: 'channel_created'; channel: ChannelPayload }
  | { op: 'channel_updated'; channel: ChannelPayload }
  | { op: 'channel_deleted'; guild_id: string; channel_id: string }
  | {
      op: 'channel_bump';
      guild_id: string;
      channel_id: string;
      message_id: string;
      author_id: string;
    }
  | { op: 'guild_updated'; guild: GuildPayload }
  | { op: 'guild_deleted'; guild_id: string }
  | { op: 'guild_member_added'; guild_id: string; user_id: string }
  | {
      op: 'voice_state';
      channel_id: string;
      user_ids: string[];
      streaming_user_ids?: string[];
      user_states?: Record<string, UserVoiceState>;
    }
  | { op: 'stream_state'; channel_id: string; user_ids: string[] }
  | {
      op: 'stream_chat_message';
      channel_id: string;
      streamer_id: string;
      message: StreamChatMessage;
    }
  | { op: 'error'; code: number; msg: string };

type ClientEvent =
  | { op: 'subscribe'; channel_id: string }
  | { op: 'unsubscribe'; channel_id: string }
  | { op: 'send'; channel_id: string; content: string; nonce: string; reply_to_id?: string | null }
  | {
      op: 'voice_self_state';
      channel_id: string | null;
      mic_muted: boolean;
      deafened: boolean;
    };

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

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
    this.connectPromise = this._dial();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
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
        // Drop loaded messages so the next channel-switch hits the REST
        // endpoint and pulls everything that arrived during the disconnect.
        // (invalidateLoaded only flips a flag — messages already in the store
        //  would be merged with the next push, leaving gaps if any history
        //  was missed.)
        for (const cid of this.subs) {
          messages.clearChannel(cid);
        }
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

  private _handle(evt: ServerEvent): void {
    // Buffer lifecycle events that arrive before `ready` has populated guilds.byId.
    if (
      !this._readyDone &&
      evt.op !== 'ready' &&
      evt.op !== 'message' &&
      evt.op !== 'message_update' &&
      evt.op !== 'message_delete' &&
      evt.op !== 'reaction_add' &&
      evt.op !== 'reaction_remove' &&
      evt.op !== 'message_ack' &&
      evt.op !== 'voice_state' &&
      evt.op !== 'stream_state' &&
      evt.op !== 'stream_chat_message' &&
      evt.op !== 'error'
    ) {
      this._preReadyBuffer.push(evt);
      return;
    }

    switch (evt.op) {
      case 'ready':
        if (evt.voice_states) voicePresence.seed(evt.voice_states);
        streamPresence.seed(evt.stream_states ?? []);
        this._readyDone = true;
        // Replay buffered lifecycle events now that guilds.byId is populated.
        for (const buffered of this._preReadyBuffer) {
          this._handle(buffered);
        }
        this._preReadyBuffer = [];
        break;
      case 'message':
        messages.upsert(evt.data);
        // Own messages don't make a channel unread for ourselves.
        if (evt.data.author_id !== auth.user?.id) {
          readState.recordSeen(evt.data.channel_id, evt.data.id);
          // We only get this op for channels we're subscribed to — i.e. the
          // one we're currently viewing — so it's safe to also mark it read.
          if (this.subs.has(evt.data.channel_id)) {
            readState.markRead(evt.data.channel_id, evt.data.id);
          }
        }
        break;
      case 'message_update':
        messages.update(evt.data);
        break;
      case 'message_delete':
        messages.remove(evt.data.channel_id, evt.data.id);
        break;
      case 'reaction_add':
        messages.applyReaction(evt.data, +1);
        break;
      case 'reaction_remove':
        messages.applyReaction(evt.data, -1);
        break;
      case 'channel_created':
        if (guilds.byId[evt.channel.guild_id]) guilds.addChannel(evt.channel);
        break;
      case 'channel_updated':
        if (guilds.byId[evt.channel.guild_id]) guilds.updateChannel(evt.channel);
        break;
      case 'channel_deleted':
        if (guilds.byId[evt.guild_id]) {
          guilds.removeChannel(evt.channel_id);
          this.unsubscribe(evt.channel_id);
          messages.clearChannel(evt.channel_id);
          for (const h of this.channelDeletedHooks) h(evt.guild_id, evt.channel_id);
        }
        break;
      case 'channel_bump':
        if (evt.author_id !== auth.user?.id && guilds.byId[evt.guild_id]) {
          readState.recordSeen(evt.channel_id, evt.message_id);
          // If we're currently viewing this channel the message op already
          // ran the markRead — but in case the bump arrived first, do it
          // again here. markRead is idempotent.
          if (this.subs.has(evt.channel_id)) {
            readState.markRead(evt.channel_id, evt.message_id);
          }
        }
        break;
      case 'guild_updated':
        if (guilds.byId[evt.guild.id]) guilds.updateGuild(evt.guild);
        break;
      case 'guild_deleted':
        if (guilds.byId[evt.guild_id]) {
          // Drop every WS subscription for channels in that guild — they're
          // gone server-side and would otherwise leak in `this.subs`.
          for (const c of guilds.channelsByGuild[evt.guild_id] ?? []) {
            this.unsubscribe(c.id);
            messages.clearChannel(c.id);
          }
          guilds.remove(evt.guild_id);
          for (const h of this.guildDeletedHooks) h(evt.guild_id);
        }
        break;
      case 'guild_member_added':
        if (auth.user && evt.user_id === auth.user.id) {
          // We just joined a guild on another tab / via an invite — re-hydrate
          // so this WS session starts tracking it (voice presence, channel
          // lifecycle). loadChannels is best-effort.
          void guilds.hydrate().then(() => guilds.loadChannels(evt.guild_id).catch(() => undefined));
        }
        break;
      case 'voice_state':
        voicePresence.apply(
          evt.channel_id,
          evt.user_ids,
          evt.streaming_user_ids,
          evt.user_states
        );
        break;
      case 'stream_state':
        streamPresence.apply(evt.channel_id, evt.user_ids ?? []);
        // Stream gone → lokaler Chat-State für absente Streamer auch raus
        // (ephemer pro Plan; Server-Liste lebt noch 6h via TTL, aber UX-seitig
        // verschwindet der Chat sofort mit dem Stream).
        streamChat.pruneAbsent(evt.channel_id, evt.user_ids ?? []);
        break;
      case 'stream_chat_message':
        streamChat.apply(evt.channel_id, evt.streamer_id, evt.message);
        break;
    }
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
    return this._sendRaw({
      op: 'send',
      channel_id: channelId,
      content,
      nonce,
      reply_to_id: replyToId ?? null
    });
  }

  /** Report the local user's mute/deafen state to the gateway so it can fan
   * it out to every other connected client. `channelId` is the voice channel
   * the user is currently in, or `null` to clear state on disconnect. */
  sendVoiceSelfState(channelId: string | null, micMuted: boolean, deafened: boolean): boolean {
    return this._sendRaw({
      op: 'voice_self_state',
      channel_id: channelId,
      mic_muted: micMuted,
      deafened: deafened
    });
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
