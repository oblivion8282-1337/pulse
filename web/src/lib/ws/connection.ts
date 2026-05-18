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
import { directMessages } from '$lib/stores/directMessages.svelte';
import { auth } from '$lib/stores/auth.svelte';
import {
  voicePresence,
  type UserVoiceState,
  type VoiceChannelState
} from '$lib/stores/voicePresence.svelte';
import { streamPresence, type StreamChannelState } from '$lib/stores/streamPresence.svelte';
import { streamChat, type StreamChatMessage } from '$lib/stores/streamChat.svelte';
import { watchChat, type WatchChatMessage } from '$lib/stores/watchChat.svelte';
import {
  watchPartyPresence,
  type WatchChannelEntry,
  type WatchPartyState
} from '$lib/stores/watchPartyPresence.svelte';
import { readState } from '$lib/stores/readState.svelte';
import { userCache } from '$lib/stores/users.svelte';
import { fireInPageNotification } from '$lib/notifications/inPage';
import { capabilities } from '$lib/stores/capabilities.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
import { memberRoles } from '$lib/stores/memberRoles.svelte';
import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import type { DMChannel, Guild, Message } from '$lib/api/types';
import type { Role as RolePayload, Overwrite as OverwritePayload } from '$lib/api/roles';

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

/** Per-guild slice of the ready frame. The role/permission fields were
 * added in Phase 3 (server-side); older payloads (e.g. mocked tests) may
 * still omit them. */
export type ReadyGuild = {
  id: string;
  name: string;
  owner_id?: string;
  my_permissions?: string;
  my_role_ids?: string[];
  roles?: RolePayload[];
};

type ServerEvent =
  | {
      op: 'ready';
      user_id: string;
      guilds: ReadyGuild[];
      dm_channels?: DMChannel[];
      voice_states?: VoiceChannelState[];
      stream_states?: StreamChannelState[];
      watch_states?: WatchChannelEntry[];
      voice_overrides?: {
        channel_id: string;
        user_id: string;
        muted: boolean;
        deafened: boolean;
      }[];
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
  | {
      // DM activity envelope. Carries the (a, b) pair so each receiving
      // client decides locally whether it's a member; non-members ignore.
      op: 'dm_bump';
      channel_id: string;
      user_a_id: string;
      user_b_id: string;
      message_id: string;
      author_id: string;
    }
  | { op: 'guild_updated'; guild: GuildPayload }
  | { op: 'guild_deleted'; guild_id: string }
  | { op: 'guild_member_added'; guild_id: string; user_id: string }
  | { op: 'guild_member_removed'; guild_id: string; user_id: string }
  | {
      op: 'guild_ban_added';
      guild_id: string;
      user_id: string;
      reason?: string | null;
    }
  | { op: 'guild_ban_removed'; guild_id: string; user_id: string }
  | {
      op: 'guild_member_updated';
      guild_id: string;
      user_id: string;
      nickname: string | null;
    }
  | {
      op: 'voice_state';
      channel_id: string;
      user_ids: string[];
      streaming_user_ids?: string[];
      user_states?: Record<string, UserVoiceState>;
    }
  | {
      op: 'voice_override';
      channel_id: string;
      user_id: string;
      muted: boolean;
      deafened: boolean;
    }
  | {
      op: 'voice_disconnect';
      channel_id: string;
      user_id: string;
    }
  | { op: 'stream_state'; channel_id: string; user_ids: string[] }
  | {
      op: 'stream_chat_message';
      channel_id: string;
      streamer_id: string;
      message: StreamChatMessage;
    }
  | { op: 'watch_state'; channel_id: string; state: WatchPartyState | null }
  | { op: 'watch_chat_message'; channel_id: string; message: WatchChatMessage }
  | {
      op: 'permissions_updated';
      allow_guild_creation: boolean;
      allow_member_invites: boolean;
    }
  | { op: 'role_created'; role: RolePayload }
  | { op: 'role_updated'; role: RolePayload }
  | { op: 'role_deleted'; guild_id: string; role_id: string }
  | { op: 'member_roles_updated'; guild_id: string; user_id: string }
  | {
      op: 'channel_permissions_updated';
      guild_id: string;
      channel_id: string;
      overwrites: OverwritePayload[];
    }
  | {
      // Per-user mention notification — fanned out only to sockets owned
      // by mentioned users, so we can bump the channel's mention counter
      // even if the user isn't currently viewing or subscribed to it.
      op: 'mention_added';
      // `guild_id` is null for DMs (the channel isn't part of a guild). The
      // backend stringifies guild_id when present (Snowflake-as-string across
      // the wire — see CLAUDE.md) and emits null for the DM case.
      d: { channel_id: string; message_id: string; guild_id: string | null };
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
    }
  | { op: 'watch_start'; channel_id: string; source_url: string }
  | { op: 'watch_stop'; channel_id: string }
  | {
      op: 'watch_control';
      channel_id: string;
      action: 'play' | 'pause' | 'seek';
      position: number;
    }
  | { op: 'watch_heartbeat'; channel_id: string; position: number };

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
      evt.op !== 'voice_override' &&
      evt.op !== 'voice_disconnect' &&
      evt.op !== 'stream_state' &&
      evt.op !== 'stream_chat_message' &&
      evt.op !== 'watch_state' &&
      evt.op !== 'watch_chat_message' &&
      evt.op !== 'permissions_updated' &&
      evt.op !== 'role_created' &&
      evt.op !== 'role_updated' &&
      evt.op !== 'role_deleted' &&
      evt.op !== 'member_roles_updated' &&
      evt.op !== 'channel_permissions_updated' &&
      evt.op !== 'guild_member_updated' &&
      evt.op !== 'guild_member_removed' &&
      evt.op !== 'guild_ban_added' &&
      evt.op !== 'guild_ban_removed' &&
      evt.op !== 'mention_added' &&
      evt.op !== 'error'
    ) {
      this._preReadyBuffer.push(evt);
      return;
    }

    switch (evt.op) {
      case 'ready':
        // Pre-seed guilds.byId so lifecycle events buffered before REST hydrate
        // don't no-op on the `if (guilds.byId[...])` guards. Uses ??= so a
        // concurrently-completed hydrate() (full Guild object) is never downgraded.
        for (const g of evt.guilds) {
          guilds.byId[g.id] ??= {
            icon_url: null,
            owner_id: g.owner_id ?? '',
            created_at: '',
            ...g
          } as Guild;
        }
        // The role payload is part of the ready envelope, not REST, so it's
        // populated here (the hydrate() pass on the REST side does not return
        // roles — they only come from /guilds/{id}/roles or this frame).
        roles.seedFromReady(evt.guilds);
        if (evt.dm_channels) directMessages.seed(evt.dm_channels);
        if (evt.voice_states) voicePresence.seed(evt.voice_states);
        voicePresence.seedOverrides(evt.voice_overrides ?? []);
        streamPresence.seed(evt.stream_states ?? []);
        watchPartyPresence.seed(evt.watch_states ?? []);
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
      case 'dm_bump': {
        // We get this fanned to every connected socket — first decide if
        // we're a member (one of the two user ids). Non-members ignore.
        const me = auth.user?.id;
        if (!me) break;
        const isMember = evt.user_a_id === me || evt.user_b_id === me;
        if (!isMember) break;
        // Upsert: bumps an existing DM's last_message_id, or creates the
        // record if the other side just opened a new DM with us (we
        // wouldn't have it in the store yet otherwise).
        directMessages.upsertFromBump({
          channel_id: evt.channel_id,
          user_a_id: evt.user_a_id,
          user_b_id: evt.user_b_id,
          message_id: evt.message_id,
          currentUserId: me
        });
        if (evt.author_id !== me) {
          readState.recordSeen(evt.channel_id, evt.message_id);
          if (this.subs.has(evt.channel_id)) {
            // Already viewing this DM — mark read, no toast.
            readState.markRead(evt.channel_id, evt.message_id);
          } else {
            // Not currently in this DM. Toast the user. We intentionally
            // surface only the sender's name, not the message content,
            // so the UX stays identical when DMs go E2EE in Phase 2.
            // userCache.queue is debounced; if the sender isn't in cache
            // yet (we've never rendered them anywhere) we just drop the
            // name from the toast rather than show a "…" placeholder.
            userCache.queue(evt.author_id);
            const cached = userCache.get(evt.author_id);
            const senderLabel = cached
              ? ` von @${cached.display_name ?? cached.username}`
              : '';
            const channelId = evt.channel_id;
            toast.message(`Neue Nachricht${senderLabel}`, {
              action: {
                label: 'Öffnen',
                onClick: () => {
                  void goto(`/app/@me/${channelId}`);
                }
              }
            });
          }
        }
        break;
      }
      case 'guild_updated':
        if (guilds.byId[evt.guild.id]) guilds.updateGuild(evt.guild);
        break;
      case 'guild_deleted':
        if (guilds.byId[evt.guild_id]) {
          // Drop every WS subscription for channels in that guild — they're
          // gone server-side and would otherwise leak in `this.subs`. We walk
          // both `subs` *and* `channelsByGuild` because the former may contain
          // ids the client never navigated to (only got via WS push).
          const channelIds = new Set<string>(
            (guilds.channelsByGuild[evt.guild_id] ?? []).map((c) => c.id),
          );
          for (const subId of this.subs) {
            if (channelIds.has(subId)) this.unsubscribe(subId);
          }
          for (const id of channelIds) messages.clearChannel(id);
          guilds.remove(evt.guild_id);
          for (const h of this.guildDeletedHooks) h(evt.guild_id);
        }
        break;
      case 'guild_member_removed':
        if (auth.user && evt.user_id === auth.user.id) {
          // The kicked user is us. Drop the guild locally — mirrors the
          // ``guild_deleted`` cleanup path (subscriptions, messages,
          // navigation hook). The WS itself isn't force-closed; the next
          // membership-gated REST call will 403 naturally.
          if (guilds.byId[evt.guild_id]) {
            const channelIds = new Set<string>(
              (guilds.channelsByGuild[evt.guild_id] ?? []).map((c) => c.id)
            );
            for (const subId of this.subs) {
              if (channelIds.has(subId)) this.unsubscribe(subId);
            }
            for (const id of channelIds) messages.clearChannel(id);
            guilds.remove(evt.guild_id);
            for (const h of this.guildDeletedHooks) h(evt.guild_id);
          }
        }
        // Either way, an open MemberList re-renders via its local
        // gateway.on listener (which re-fetches on this op).
        break;
      case 'guild_member_added':
        if (auth.user && evt.user_id === auth.user.id) {
          // We just joined a guild on another tab / via an invite — re-hydrate
          // so this WS session starts tracking it (voice presence, channel
          // lifecycle, role list). loadChannels + role fetch are best-effort.
          void guilds.hydrate().then(() => {
            void guilds.loadChannels(evt.guild_id).catch(() => undefined);
            // Pull the role list + recompute resolved perms — without this
            // the UI gates stay locked until the next WS reconnect.
            import('$lib/api/roles').then(({ rolesApi }) => {
              rolesApi
                .list(evt.guild_id)
                .then((rows) => {
                  for (const r of rows) roles.upsertRole(r);
                  roles.recomputeGuild(evt.guild_id);
                })
                .catch(() => undefined);
            });
          });
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
      case 'voice_disconnect': {
        // Server admin yanked someone out of voice. If that's us in the
        // channel we're connected to, drop the LiveKit room locally —
        // LiveKit may have already removed the participant, but the
        // explicit disconnect ensures our UI state catches up
        // immediately instead of waiting for the close event.
        if (auth.user?.id === evt.user_id) {
          void import('$lib/voice/livekit.svelte').then(({ voice }) => {
            if (voice.channelId !== evt.channel_id) return;
            void voice.disconnect();
          });
        }
        break;
      }
      case 'voice_override': {
        voicePresence.applyOverride(
          evt.channel_id,
          evt.user_id,
          evt.muted,
          evt.deafened
        );
        // Deafen enforcement is *soft* — LiveKit's per-participant
        // permission model doesn't gate inbound subscriptions, only
        // outbound publishes. We drive voice.setDeafened so the local
        // audio output mutes and the toggle is disabled, but a
        // tampered client could still play subscribed audio. Same
        // trust model as Discord's server-deafen. Mute is server-
        // enforced via LiveKit publish-permissions (see voice-
        // signaling/_livekit_update_participant).
        // Lazy-imported to avoid the circular dep with voice/livekit.
        if (auth.user?.id === evt.user_id) {
          void import('$lib/voice/livekit.svelte').then(({ voice }) => {
            if (voice.channelId !== evt.channel_id) return;
            if (evt.deafened !== voice.deafened) voice.setDeafened(evt.deafened);
          });
        }
        break;
      }
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
      case 'watch_state':
        watchPartyPresence.apply(evt.channel_id, evt.state);
        if (evt.state === null) watchChat.clear(evt.channel_id);
        break;
      case 'watch_chat_message':
        watchChat.apply(evt.channel_id, evt.message);
        break;
      case 'permissions_updated':
        capabilities.apply({
          allow_guild_creation: evt.allow_guild_creation,
          allow_member_invites: evt.allow_member_invites
        });
        break;
      case 'role_created':
      case 'role_updated':
        roles.upsertRole(evt.role);
        break;
      case 'role_deleted':
        roles.removeRole(evt.guild_id, evt.role_id);
        break;
      case 'member_roles_updated':
        // Only the target user's role list changed. If we are them, the
        // resolved-permissions store needs to re-pull. Either way, drop
        // the lazy cache for this (guild, user) so the next access
        // re-fetches with the new state — and immediately kick off the
        // refetch via `ensure` so MemberList's hoist-group + colour
        // re-derive correctly instead of falling back to "Online" /
        // default colour until the user navigates.
        if (auth.user?.id === evt.user_id) {
          void roles.refreshMyRoles(evt.guild_id);
        }
        memberRoles.invalidate(evt.guild_id, evt.user_id);
        void memberRoles.ensure(evt.guild_id, evt.user_id).catch(() => undefined);
        break;
      case 'channel_permissions_updated':
        channelPermissions.apply(evt.channel_id, evt.overwrites);
        break;
      case 'mention_added': {
        // Per-user notification fanned out only to mentioned sockets. We
        // intentionally drive the unread-mention badge from THIS event
        // only (not from `message.mentions`) so the counter logic stays
        // idempotent: the backend deduplicates the recipient set, we
        // don't have to. If the user is actively viewing the channel,
        // the inline `markRead` below clears the counter immediately.
        const { channel_id, message_id, guild_id } = evt.d;
        readState.incMention(channel_id);
        if (this.subs.has(channel_id)) {
          readState.markRead(channel_id, message_id);
        }
        // In-page notification (only fires when tab is in background — the
        // helper gates on visibility + settings). The matching push from the
        // SW collapses on the shared `message_id` tag, so the user sees one
        // popup at most. Look up the message we just received for body text;
        // it may not be in the local store yet if the user has never opened
        // the channel — in that case we fall back to a generic body.
        const msg = messages.for(channel_id).find((m) => m.id === message_id);
        const author = msg
          ? userCache.get(msg.author_id) ?? null
          : null;
        const authorName = author?.display_name ?? author?.username ?? 'Jemand';
        const snippet = msg?.content?.slice(0, 140) ?? 'hat dich erwähnt';
        const channelName = (() => {
          if (guild_id) {
            const list = guilds.channelsByGuild[guild_id] ?? [];
            const c = list.find((x) => x.id === channel_id);
            return c?.name ? `#${c.name}` : 'einem Kanal';
          }
          return 'einer Direktnachricht';
        })();
        fireInPageNotification({
          kind: guild_id ? 'mention' : 'dm',
          title: `${authorName} in ${channelName}`,
          body: snippet,
          channelId: channel_id,
          messageId: message_id,
          guildId: guild_id
        });
        break;
      }
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

  /** Kick off a watch party in this voice channel. Server validates `sourceUrl`
   * and rejects with `{op:"error", code: 4013}` if it's an unsupported source,
   * `4014` if a party is already active in the channel. */
  startWatchParty(channelId: string, sourceUrl: string): boolean {
    return this._sendRaw({ op: 'watch_start', channel_id: channelId, source_url: sourceUrl });
  }

  /** Host-only stop. Server replies with `{op:"watch_state", state: null}`. */
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

  /** Host emits this every ~3s so viewers can correct drift. Server debounces
   * the write to ≤1 / 2s; sending faster is harmless but wasteful. */
  sendWatchHeartbeat(channelId: string, position: number): boolean {
    return this._sendRaw({ op: 'watch_heartbeat', channel_id: channelId, position });
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
