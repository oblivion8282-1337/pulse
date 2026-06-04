/**
 * Wire-type definitions for the chat-gateway WebSocket.
 *
 * Lives here (rather than in `connection.ts`) so the handler-map split can
 * import discriminants without pulling in the connection class. The union
 * stays exhaustive — every op the server emits has a variant. New events
 * extend `ServerEvent` and get a matching handler module under
 * `lib/ws/handlers/*`.
 */
import type { DMChannel, Message } from '$lib/api/types';
import type { Role as RolePayload, Overwrite as OverwritePayload } from '$lib/api/roles';
import type { UserVoiceState, VoiceChannelState } from '$lib/stores/voicePresence.svelte';
import type { StreamChannelState } from '$lib/stores/streamPresence.svelte';
import type { StreamChatMessage } from '$lib/stores/streamChat.svelte';
import type { WatchChatMessage } from '$lib/stores/watchChat.svelte';
import type { WatchChannelEntry, WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
import type { FriendRequest } from '$lib/stores/friendRequests.svelte';
import type { PrivacySettings } from '$lib/stores/privacy.svelte';
import type { PresenceStatus, OwnPresenceStatus } from '$lib/stores/presence.svelte';

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

export type ReactionEvent = {
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
  icon_url?: string | null;
  created_at?: string;
  owner_id?: string;
  my_permissions?: string;
  my_role_ids?: string[];
  roles?: RolePayload[];
  sound_overrides?: { sound_id: string; url: string }[];
};

export type ReadyEvent = {
  op: 'ready';
  user_id: string;
  /** Admin status on THIS server. Optional for back-compat with mocked frames. */
  is_admin?: boolean;
  guilds: ReadyGuild[];
  dm_channels?: DMChannel[];
  voice_states?: VoiceChannelState[];
  stream_states?: StreamChannelState[];
  watch_states?: WatchChannelEntry[];
  /** Server clock (unix ms) at ready-send time — seeds the watch-party clock
   * offset so position extrapolation uses the shared server clock. */
  server_now?: number;
  online_user_ids?: string[];
  voice_overrides?: {
    channel_id: string;
    user_id: string;
    muted: boolean;
    deafened: boolean;
  }[];
  // Etappe 4 friend-system payload — all optional so older mocked
  // ready frames in tests keep validating cleanly.
  friends?: { user_id: string; since: string }[];
  friend_requests_in?: FriendRequest[];
  friend_requests_out?: FriendRequest[];
  blocked_user_ids?: string[];
  privacy?: PrivacySettings;
  presence_status?: OwnPresenceStatus;
  user_presence_statuses?: Record<string, PresenceStatus>;
};

export type ServerEvent =
  | ReadyEvent
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
      camera_user_ids?: string[];
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
  | { op: 'presence_update'; user_id: string; online: boolean }
  | {
      op: 'stream_chat_message';
      channel_id: string;
      streamer_id: string;
      message: StreamChatMessage;
    }
  | {
      op: 'watch_state';
      channel_id: string;
      state: WatchPartyState | null;
      /** Server clock (unix ms) at push time — keeps the client's clock
       * offset calibrated for position extrapolation. */
      server_now?: number;
    }
  | { op: 'watch_watchers'; channel_id: string; user_ids: string[] }
  | { op: 'watch_chat_message'; channel_id: string; message: WatchChatMessage }
  | {
      op: 'permissions_updated';
      allow_guild_creation: boolean;
      allow_member_invites: boolean;
      guild_sound_max_size_bytes?: number;
      hq_bitrate_min_kbps?: number;
      hq_bitrate_max_kbps?: number;
      hq_fps_min?: number;
      hq_fps_max?: number;
      hq_resolution_max?: string;
      ns_bitrate_min_kbps?: number;
      ns_bitrate_max_kbps?: number;
      ns_fps_min?: number;
      ns_fps_max?: number;
      ns_resolution_max?: string;
      cam_resolution_max?: string;
      cam_fps_max?: number;
    }
  | {
      op: 'guild_sound_updated';
      guild_id: string;
      sound_id: string;
      removed: boolean;
    }
  | {
      // Guild-Admin hat ein Plugin auf der Guild ein-/ausgeschaltet
      // (PUT /guilds/{id}/plugins/{name}) ODER der Bootstrap-Admin
      // hat das Plugin instanzweit deaktiviert (DELETE /admin/plugins/{name})
      // — letzteres pusht ein Event pro betroffener Guild mit enabled=false.
      // Receiver invalidiert seinen guild-activation-Cache.
      op: 'guild_plugins_changed';
      guild_id: string;
      plugin_name: string;
      enabled: boolean;
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
      data: { channel_id: string; message_id: string; guild_id: string | null };
    }
  // ---- Etappe 4 friend system ------------------------------------------
  | { op: 'friend_request_received'; data: FriendRequest }
  | {
      op: 'friend_request_accepted';
      data: { request_id: string; friendship: { user_id: string; since: string } };
    }
  | { op: 'friend_request_declined'; data: { request_id: string } }
  | { op: 'friend_request_cancelled'; data: { request_id: string } }
  | { op: 'friend_removed'; data: { user_id: string } }
  | { op: 'user_blocked'; data: { user_id: string } }
  | { op: 'user_unblocked'; data: { user_id: string } }
  | {
      op: 'presence_status_changed';
      data: { user_id: string; status: PresenceStatus | 'invisible' };
    }
  | { op: 'error'; code: number; msg: string };

export type ClientEvent =
  | { op: 'subscribe'; channel_id: string }
  | { op: 'unsubscribe'; channel_id: string }
  // Cloud-signiertes Profile-Statement → der Server cached den Anzeige-Namen
  // (CachedUserProfile). Ohne das zeigen Self-Hosts nur die rohe user-<id> (F19).
  | { op: 'profile_statement'; jwt: string }
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
  | { op: 'watch_heartbeat'; channel_id: string; position: number }
  | { op: 'watch_join'; channel_id: string }
  | { op: 'watch_leave'; channel_id: string }
  | { op: 'watch_handoff'; channel_id: string; target_user_id?: string }
  | { op: 'activity' }
  | { op: 'ping' };

/** Narrow `ServerEvent` to the variant that has the given `op`. Used by
 *  individual handler modules so they keep static-typing on `evt`. */
export type EventOf<Op extends ServerEvent['op']> = Extract<ServerEvent, { op: Op }>;
