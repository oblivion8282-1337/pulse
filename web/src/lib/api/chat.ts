import { request, requestForm } from './client';
import { serversStore } from './servers.svelte';
import type {
  AcceptInviteResult,
  Ban,
  Channel,
  DMChannel,
  Guild,
  Invite,
  InvitePreview,
  Member,
  Message,
  ReactionUserList
} from './types';

/** Response of `GET /guilds/{id}/settings` (MANAGE_GUILD-gated). */
export type GuildSettings = {
  handle: string | null;
  is_public: boolean;
};

/** Response von `GET /c/{handle}` — öffentliche Community-Vorschau.
 *  Spiegelt `PublicCommunityPreviewOut` aus dem Backend. */
export type PublicCommunityPreview = {
  guild: { id: string; name: string; icon_url: string | null };
  member_count: number;
  is_public: boolean;
};
import type { StreamChatMessage } from '$lib/stores/streamChat.svelte';
import type { WatchChatMessage } from '$lib/stores/watchChat.svelte';

/** A single per-guild sound override returned by GET/PUT
 * `/guilds/{gid}/sounds[/{sound_id}]`. ``url`` is a fresh presigned GET URL
 * (TTL 30 min — engine re-loads on next WS event / reconnect). */
export type GuildSoundOverrideOut = {
  sound_id: string;
  url: string;
  content_type: string;
  file_size: number;
  original_filename: string;
  uploaded_by_id: string;
  uploaded_at: string;
};

/** Response of `POST /channels/{id}/stream-token` (chat-gateway → media-svc proxy). */
export type StreamTokenResponse = {
  token: string;
  mediamtx_path: string;
  push_protocol: string;
  /** Full push URL including the token, ready for the GSR sidecar. */
  push_url: string;
  expires_in_s: number;
};

/** Global-Friends Stufe 1: DMs sind cloud-only → immer gegen den Cloud-Server routen. */
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Read-only view of the server-wide permission flags. */
export type ServerCapabilities = {
  allow_guild_creation: boolean;
  allow_member_invites: boolean;
  guild_sound_max_size_bytes: number;
  hq_bitrate_min_kbps: number;
  hq_bitrate_max_kbps: number;
  hq_fps_min: number;
  hq_fps_max: number;
  hq_resolution_max: string;
  ns_bitrate_min_kbps: number;
  ns_bitrate_max_kbps: number;
  ns_fps_min: number;
  ns_fps_max: number;
  ns_resolution_max: string;
  cam_resolution_max: string;
  cam_fps_max: number;
  /** Upload-surface policy of THIS server (instance-level, env-driven).
   * Optional: an older instance omits them → treat as unrestricted.
   * UI hint only — the server enforces the same rules regardless. */
  dm_attachments_enabled?: boolean;
  dropbox_enabled?: boolean;
  /** Allowed MIME prefixes for message attachments; empty = unrestricted. */
  attachment_mime_prefixes?: string[];
};

export const chatApi = {
  // Guilds. ``serverId`` routet das Request an einen spezifischen Server-
  // Eintrag (Sidebar braucht das für die Multi-Server-Sektionen — sonst
  // läuft jedes /guilds gegen den aktiven Server, was die Cross-Server-
  // Liste zerschießt).
  listGuilds(opts?: { serverId?: string }): Promise<Guild[]> {
    return request<Guild[]>('/guilds', {}, { serverId: opts?.serverId });
  },
  createGuild(name: string, icon_url: string | null = null): Promise<Guild> {
    return request<Guild>('/guilds', {
      method: 'POST',
      body: { name, icon_url }
    });
  },
  getGuild(id: string): Promise<Guild> {
    return request<Guild>(`/guilds/${id}`);
  },
  patchGuild(
    id: string,
    payload: {
      name?: string;
      icon_url?: string | null;
      attachment_max_size_bytes?: number;
      attachment_max_count_per_message?: number;
    }
  ): Promise<Guild> {
    return request<Guild>(`/guilds/${id}`, { method: 'PATCH', body: payload });
  },
  deleteGuild(id: string): Promise<void> {
    return request<void>(`/guilds/${id}`, { method: 'DELETE' });
  },
  uploadGuildIcon(id: string, file: File): Promise<Guild> {
    const form = new FormData();
    form.append('file', file);
    return requestForm<Guild>(`/guilds/${id}/icon`, form);
  },
  deleteGuildIcon(id: string): Promise<void> {
    return request<void>(`/guilds/${id}/icon`, { method: 'DELETE' });
  },

  // Per-guild sound overrides
  listGuildSounds(guildId: string): Promise<GuildSoundOverrideOut[]> {
    return request<GuildSoundOverrideOut[]>(`/guilds/${guildId}/sounds`);
  },
  uploadGuildSound(
    guildId: string,
    soundId: string,
    file: File
  ): Promise<GuildSoundOverrideOut> {
    const form = new FormData();
    form.append('file', file);
    return requestForm<GuildSoundOverrideOut>(
      `/guilds/${guildId}/sounds/${soundId}`,
      form,
      { method: 'PUT' }
    );
  },
  deleteGuildSound(guildId: string, soundId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/sounds/${soundId}`, {
      method: 'DELETE'
    });
  },

  // Members
  listMembers(guildId: string): Promise<Member[]> {
    return request<Member[]>(`/guilds/${guildId}/members`);
  },
  /** Direct invite-by-id: adds a user to the guild by their numeric user ID.
   *  Backend gates on MANAGE_INVITES and rejects banned users. Idempotent. */
  addMemberById(guildId: string, userId: string): Promise<Member> {
    return request<Member>(`/guilds/${guildId}/members`, {
      method: 'POST',
      body: { user_id: userId }
    });
  },
  setSelfNickname(guildId: string, nickname: string): Promise<Member> {
    return this.setMemberNickname(guildId, '@me', nickname);
  },
  setMemberNickname(guildId: string, userId: string, nickname: string): Promise<Member> {
    return request<Member>(`/guilds/${guildId}/members/${userId}`, {
      method: 'PATCH',
      body: { nickname }
    });
  },
  kickMember(guildId: string, userId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
  },
  /** Leave a community yourself (self-removal). Works for Cloud + Self-Host. */
  leaveGuild(guildId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/members/@me`, { method: 'DELETE' });
  },

  // Bans
  listBans(guildId: string): Promise<Ban[]> {
    return request<Ban[]>(`/guilds/${guildId}/bans`);
  },
  banUser(guildId: string, userId: string, reason: string | null = null): Promise<Ban> {
    return request<Ban>(`/guilds/${guildId}/bans/${userId}`, {
      method: 'PUT',
      body: { reason }
    });
  },
  unbanUser(guildId: string, userId: string): Promise<void> {
    return request<void>(`/guilds/${guildId}/bans/${userId}`, { method: 'DELETE' });
  },

  // Channels. ``route`` pinnt das Request an einen bestimmten Server
  // (Guild-Rail-Tooltip braucht das für Communitys nicht-aktiver Server).
  listChannels(guildId: string, route: { serverId?: string } = {}): Promise<Channel[]> {
    return request<Channel[]>(`/guilds/${guildId}/channels`, {}, route);
  },
  /** Voice-Presence-Snapshot einer Community per REST. Für den aktiven
   *  Server kommt dasselbe live über den WS (`ready` + `voice_state`) —
   *  dieser Endpoint deckt die nicht-aktiven Server-Sektionen ab. Liefert
   *  je Channel neben den User-IDs auch die Screen-Share-Streamer und die
   *  User mit aktivierter Kamera (beides server-seitig via LiveKit-Webhooks
   *  in Redis gepflegt). */
  guildVoiceState(
    guildId: string,
    route: { serverId?: string } = {}
  ): Promise<{
    voice_states: {
      channel_id: string;
      user_ids: string[];
      streaming_user_ids: string[];
      camera_user_ids: string[];
    }[];
  }> {
    return request(`/guilds/${guildId}/voice-state`, {}, route);
  },
  /** HQ-Stream-Snapshot einer Community per REST (GSR → MediaMTX → WHEP).
   *  Spiegelt `stream_states` aus dem `ready`-Frame; `streams` fehlt bei
   *  einslotigen Streams (Legacy-Shape). Dient dem Rail-Tooltip fremder
   *  Server, um die LIVE-Badge neben der reinen Screen-Share zu füllen. */
  guildStreamState(
    guildId: string,
    route: { serverId?: string } = {}
  ): Promise<{
    stream_states: {
      channel_id: string;
      user_ids: string[];
      streams?: { user_id: string; slot?: number; label?: string | null }[];
    }[];
  }> {
    return request(`/guilds/${guildId}/stream-state`, {}, route);
  },
  /** Watch-Party-Snapshot einer Community per REST. Eine Channel kann mehrere
   *  Parties gleichzeitig halten → ein Eintrag pro aktiver Party. `host_user_id`
   *  treibt die PARTY-Badge im Rail-Tooltip fremder Server. */
  guildWatchState(
    guildId: string,
    route: { serverId?: string } = {}
  ): Promise<{
    watch_states: {
      channel_id: string;
      party_id: string;
      state: { host_user_id: string } & Record<string, unknown>;
    }[];
  }> {
    return request(`/guilds/${guildId}/watch-state`, {}, route);
  },
  createChannel(
    guildId: string,
    payload: { name: string; type?: number; topic?: string | null; position?: number }
  ): Promise<Channel> {
    return request<Channel>(`/guilds/${guildId}/channels`, {
      method: 'POST',
      body: { type: 0, position: 0, topic: null, ...payload }
    });
  },
  deleteChannel(channelId: string): Promise<void> {
    return request<void>(`/channels/${channelId}`, { method: 'DELETE' });
  },
  patchChannel(
    channelId: string,
    payload: {
      name?: string;
      topic?: string;
      name_color?: string | null;
      name_color_secondary?: string | null;
      name_gradient_angle?: number | null;
      user_limit?: number;
    }
  ): Promise<Channel> {
    return request<Channel>(`/channels/${channelId}`, { method: 'PATCH', body: payload });
  },
  /** Bulk-set channel positions (drag-and-drop reorder). Needs MANAGE_CHANNELS. */
  setChannelPositions(
    guildId: string,
    positions: { id: string; position: number }[]
  ): Promise<Channel[]> {
    return request<Channel[]>(`/guilds/${guildId}/channels-positions`, {
      method: 'PATCH',
      body: { positions }
    });
  },

  // Messages. ``route`` (optional) pinnt das Request an einen bestimmten
  // Server — Guild-Channels lassen es weg (→ aktiver Server), DMs übergeben
  // den Cloud-Server (Global-Friends Stufe 1: DMs sind cloud-only und müssen
  // auch bei aktivem Self-Host gegen die Cloud laufen).
  listMessages(
    channelId: string,
    opts: { before?: string; after?: string; limit?: number } = {},
    route: { serverId?: string } = {}
  ): Promise<Message[]> {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    if (opts.after) params.set('after', opts.after);
    params.set('limit', String(opts.limit ?? 50));
    return request<Message[]>(`/channels/${channelId}/messages?${params.toString()}`, {}, route);
  },
  postMessage(
    channelId: string,
    content: string,
    opts: { nonce?: string; replyToId?: string | null; attachmentIds?: string[] } = {},
    route: { serverId?: string } = {}
  ): Promise<Message> {
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content,
        nonce: opts.nonce ?? null,
        reply_to_id: opts.replyToId ?? null,
        attachment_ids: opts.attachmentIds ?? []
      }
    }, route);
  },
  editMessage(
    messageId: string,
    content: string,
    opts: { attachmentIds?: string[] } = {},
    route: { serverId?: string } = {}
  ): Promise<Message> {
    return request<Message>(`/messages/${messageId}`, {
      method: 'PATCH',
      body: { content, attachment_ids: opts.attachmentIds ?? [] }
    }, route);
  },
  deleteMessage(messageId: string, route: { serverId?: string } = {}): Promise<void> {
    return request<void>(`/messages/${messageId}`, { method: 'DELETE' }, route);
  },

  // ── Attachments (two-phase upload) ─────────────────────────────────────
  /** Step 1: ask the server for a presigned PUT URL + a new attachment id.
   * After this resolves, the client uploads the file's bytes via XHR
   * (so we get progress events) directly to MinIO. Step 2 is to include
   * this id in `postMessage({ attachmentIds: [...] })`. */
  requestAttachmentUploadUrl(
    channelId: string,
    body: {
      filename: string;
      mime: string;
      size: number;
      width?: number;
      height?: number;
      has_thumb?: boolean;
      thumb_size?: number;
      thumb_width?: number;
      thumb_height?: number;
    }
  ): Promise<{ id: string; upload_url: string; thumb_upload_url: string | null }> {
    return request(`/channels/${channelId}/attachments/upload-url`, {
      method: 'POST',
      body
    });
  },
  /** Re-sign an existing attachment when its presigned URL has expired
   * (browser hit 403). Returns fresh `url` (+ `thumb_url` if present). */
  refreshAttachmentDownloadUrl(
    attachmentId: string
  ): Promise<{ url: string; thumb_url: string | null }> {
    return request(`/attachments/${attachmentId}/download-url`, {
      endpoint: 'chat'
    });
  },

  /** Read-only view of the server-wide permission flags. The admin panel
   *  toggles these via `/admin/permissions`; the frontend gates create-
   *  guild + create-invite buttons on the result. Refetched live via
   *  the `permissions_updated` WS event. */
  getCapabilities(opts?: { serverId?: string }): Promise<ServerCapabilities> {
    return request('/capabilities', { endpoint: 'chat' }, { serverId: opts?.serverId });
  },
  _reactionRequest(
    method: 'PUT' | 'DELETE',
    messageId: string,
    emoji: string,
    route: { serverId?: string }
  ): Promise<void> {
    return request<void>(
      `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method },
      route
    );
  },
  addReaction(messageId: string, emoji: string, route: { serverId?: string } = {}): Promise<void> {
    return this._reactionRequest('PUT', messageId, emoji, route);
  },
  removeReaction(messageId: string, emoji: string, route: { serverId?: string } = {}): Promise<void> {
    return this._reactionRequest('DELETE', messageId, emoji, route);
  },
  /** Per-emoji user-id list for the "who reacted" popover. Backs
   *  `MessageReactions` so the user list loads only when the pill is
   *  opened, keeping the regular message payload aggregated. Display
   *  info (name, avatar, color) is resolved client-side via
   *  `GET /users?ids=...` (the userCache store does this batched). */
  listMessageReactions(
    messageId: string,
    route: { serverId?: string } = {}
  ): Promise<ReactionUserList[]> {
    return request<ReactionUserList[]>(
      `/messages/${messageId}/reactions`,
      {},
      route
    );
  },

  // Direct messages — 1:1 DM channels. Polymorphic with guild channels at the
  // wire level: once a DM channel id is in hand, list/post messages go through
  // the same `/channels/{id}/messages` endpoints as guild channels.
  // Global-Friends Stufe 1: DMs sind cloud-only → immer gegen den Cloud-Server.
  listDMChannels(): Promise<DMChannel[]> {
    return request<DMChannel[]>('/dm-channels', {}, cloudRoute());
  },
  createOrGetDMChannel(targetUserId: string): Promise<DMChannel> {
    return request<DMChannel>('/dm-channels', {
      method: 'POST',
      body: { target_user_id: targetUserId }
    }, cloudRoute());
  },
  getDMChannel(dmChannelId: string): Promise<DMChannel> {
    return request<DMChannel>(`/dm-channels/${dmChannelId}`, {}, cloudRoute());
  },

  // Invites
  createInvite(
    guildId: string,
    opts: { expiresInSeconds?: number; maxUses?: number; channelId?: string } = {}
  ): Promise<Invite> {
    const body: Record<string, unknown> = {};
    if (opts.expiresInSeconds !== undefined) body.expires_in_seconds = opts.expiresInSeconds;
    if (opts.maxUses !== undefined) body.max_uses = opts.maxUses;
    if (opts.channelId !== undefined) body.channel_id = opts.channelId;
    return request<Invite>(`/guilds/${guildId}/invites`, { method: 'POST', body });
  },
  listInvites(guildId: string): Promise<Invite[]> {
    return request<Invite[]>(`/guilds/${guildId}/invites`);
  },
  revokeInvite(code: string): Promise<void> {
    return request<void>(`/invites/${code}`, { method: 'DELETE' });
  },
  getInvitePreview(code: string): Promise<InvitePreview> {
    return request<InvitePreview>(`/invites/${code}`);
  },
  acceptInvite(code: string): Promise<AcceptInviteResult> {
    return request<AcceptInviteResult>(`/invites/${code}/accept`, { method: 'POST' });
  },

  // Public address (Stufe 4)
  /** MANAGE_GUILD-gated: aktuellen Handle + is_public-Status holen. */
  getGuildSettings(id: string): Promise<GuildSettings> {
    return request<GuildSettings>(`/guilds/${id}/settings`);
  },
  /** MANAGE_GUILD-gated: Handle und/oder is_public setzen. 400 = Handle fehlt bei
   *  is_public=true; 409 = Handle bereits vergeben.
   *  Hinweis: Backend gibt GuildOut zurück (kein handle/is_public) — Caller holt
   *  danach getGuildSettings für den aktualisierten State. */
  patchGuildPublicAddress(
    id: string,
    payload: { handle?: string | null; is_public?: boolean },
  ): Promise<Guild> {
    return request<Guild>(`/guilds/${id}`, { method: 'PATCH', body: payload });
  },
  /** Öffentliche Community-Vorschau. Erfordert Auth (Backend: CurrentUser).
   *  ``route`` pinnt das Request an einen bestimmten Server — auf der Cloud weglassen. */
  getPublicCommunityPreview(
    handle: string,
    route: { serverId?: string } = {},
  ): Promise<PublicCommunityPreview> {
    return request<PublicCommunityPreview>(`/c/${encodeURIComponent(handle)}`, {}, route);
  },
  /** Öffentlicher Community-Beitritt. Idempotent; 404 wenn nicht public, 403 gebannt. */
  joinPublicCommunity(
    handle: string,
    route: { serverId?: string } = {},
  ): Promise<AcceptInviteResult> {
    return request<AcceptInviteResult>(
      `/c/${encodeURIComponent(handle)}/join`,
      { method: 'POST' },
      route,
    );
  },

  // HQ streaming (T4) — chat-gateway is the membership-gated front door for media-svc.
  /**
   * Mint a short-lived publish token for the channel's HQ stream. The caller
   * must be a member of the channel's guild and the channel must be a voice
   * channel. The returned `push_url` already carries the token.
   */
  getStreamToken(
    channelId: string,
    protocol: 'rtmp' = 'rtmp',
    slot = 0,
    label?: string
  ): Promise<StreamTokenResponse> {
    return request<StreamTokenResponse>(`/channels/${channelId}/stream-token`, {
      method: 'POST',
      body: { protocol, slot, ...(label ? { label } : {}) }
    });
  },
  /**
   * Explicitly stop our own HQ stream(s) in `channelId` — clears the "live"
   * presence badge for viewers immediately instead of waiting for the MediaMTX
   * poll (~10-16s lag). `slot` omitted stops all of our streams; pass a slot to
   * stop just that one. Best-effort: the sidecar is already stopped locally and
   * the media-svc poller is the backstop, so callers fire-and-forget.
   */
  stopStream(channelId: string, slot?: number): Promise<void> {
    const q = slot === undefined ? '' : `?slot=${slot}`;
    return request<void>(`/channels/${channelId}/stream${q}`, { method: 'DELETE' });
  },
  /** WHEP playback URL for `userId`'s HQ stream in `channelId`. `slot` picks
   *  which of that user's streams (0 = primary, default). */
  getWhepUrl(channelId: string, userId: string, slot = 0): Promise<{ whep_url: string }> {
    return request<{ whep_url: string }>(
      `/channels/${channelId}/whep?user_id=${encodeURIComponent(userId)}&slot=${slot}`
    );
  },
  // Live-Chat pro HQ-Stream (Twitch-style, ephemer — Server-TTL 6h, Client-State
  // pro Streamer in `streamChat.svelte.ts`).
  /** Post a message into a streamer's live chat. 410 if the stream isn't active. */
  postStreamChat(
    channelId: string,
    streamerId: string,
    content: string
  ): Promise<{ id: string; created_at: string }> {
    return request<{ id: string; created_at: string }>(
      `/channels/${channelId}/streams/${streamerId}/chat`,
      { method: 'POST', body: { content } }
    );
  },
  /** Backfill the live chat (chronological order, oldest first). */
  getStreamChat(
    channelId: string,
    streamerId: string,
    limit = 100
  ): Promise<StreamChatMessage[]> {
    return request<StreamChatMessage[]>(
      `/channels/${channelId}/streams/${streamerId}/chat?limit=${limit}`
    );
  },

  // Watch-Party chat (one chat per party, ephemeral, 6h TTL).
  /** Post a message into a party's watch-party chat. 410 if it isn't running. */
  postWatchChat(
    channelId: string, partyId: string, content: string
  ): Promise<{ id: string; created_at: string }> {
    return request<{ id: string; created_at: string }>(
      `/channels/${channelId}/watch-party/${partyId}/chat`,
      { method: 'POST', body: { content } }
    );
  },
  /** Backfill a party's watch-party chat (chronological order, oldest first). */
  getWatchChat(channelId: string, partyId: string, limit = 100): Promise<WatchChatMessage[]> {
    return request<WatchChatMessage[]>(
      `/channels/${channelId}/watch-party/${partyId}/chat?limit=${limit}`
    );
  },
  /** Toggle an emoji reaction on a watch-party chat message (ephemeral, 6h TTL).
   *  Idempotent per call — a second toggle with the same emoji removes it. */
  toggleWatchChatReaction(
    channelId: string,
    partyId: string,
    messageId: string,
    emoji: string
  ): Promise<{ emoji: string; count: number; me: boolean }> {
    return request<{ emoji: string; count: number; me: boolean }>(
      `/channels/${channelId}/watch-party/${partyId}/chat/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'PUT' }
    );
  }
};
