import { request, requestForm } from './client';
import type {
  AcceptInviteResult,
  Channel,
  DMChannel,
  Guild,
  Invite,
  InvitePreview,
  Member,
  Message
} from './types';
import type { StreamChatMessage } from '$lib/stores/streamChat.svelte';
import type { WatchChatMessage } from '$lib/stores/watchChat.svelte';

/** Response of `POST /channels/{id}/stream-token` (chat-gateway → media-svc proxy). */
export type StreamTokenResponse = {
  token: string;
  mediamtx_path: string;
  push_protocol: string;
  /** Full push URL including the token, ready for the GSR sidecar. */
  push_url: string;
  expires_in_s: number;
};

export const chatApi = {
  // Guilds
  listGuilds(): Promise<Guild[]> {
    return request<Guild[]>('/guilds');
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
  patchGuild(id: string, payload: { name?: string; icon_url?: string | null }): Promise<Guild> {
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

  // Members
  listMembers(guildId: string): Promise<Member[]> {
    return request<Member[]>(`/guilds/${guildId}/members`);
  },

  // Channels
  listChannels(guildId: string): Promise<Channel[]> {
    return request<Channel[]>(`/guilds/${guildId}/channels`);
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
    payload: { name?: string; topic?: string }
  ): Promise<Channel> {
    return request<Channel>(`/channels/${channelId}`, { method: 'PATCH', body: payload });
  },

  // Messages
  listMessages(
    channelId: string,
    opts: { before?: string; limit?: number } = {}
  ): Promise<Message[]> {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    params.set('limit', String(opts.limit ?? 50));
    return request<Message[]>(`/channels/${channelId}/messages?${params.toString()}`);
  },
  postMessage(
    channelId: string,
    content: string,
    opts: { nonce?: string; replyToId?: string | null; attachmentIds?: string[] } = {}
  ): Promise<Message> {
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content,
        nonce: opts.nonce ?? null,
        reply_to_id: opts.replyToId ?? null,
        attachment_ids: opts.attachmentIds ?? []
      }
    });
  },
  editMessage(
    messageId: string,
    content: string,
    opts: { attachmentIds?: string[] } = {}
  ): Promise<Message> {
    return request<Message>(`/messages/${messageId}`, {
      method: 'PATCH',
      body: { content, attachment_ids: opts.attachmentIds ?? [] }
    });
  },
  deleteMessage(messageId: string): Promise<void> {
    return request<void>(`/messages/${messageId}`, { method: 'DELETE' });
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
  getCapabilities(): Promise<{ allow_guild_creation: boolean; allow_member_invites: boolean }> {
    return request('/capabilities', { endpoint: 'chat' });
  },
  addReaction(messageId: string, emoji: string): Promise<void> {
    return request<void>(
      `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'PUT' }
    );
  },
  removeReaction(messageId: string, emoji: string): Promise<void> {
    return request<void>(
      `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'DELETE' }
    );
  },

  // Direct messages — 1:1 DM channels. Polymorphic with guild channels at the
  // wire level: once a DM channel id is in hand, list/post messages go through
  // the same `/channels/{id}/messages` endpoints as guild channels.
  listDMChannels(): Promise<DMChannel[]> {
    return request<DMChannel[]>('/dm-channels');
  },
  createOrGetDMChannel(targetUserId: string): Promise<DMChannel> {
    return request<DMChannel>('/dm-channels', {
      method: 'POST',
      body: { target_user_id: targetUserId }
    });
  },
  getDMChannel(dmChannelId: string): Promise<DMChannel> {
    return request<DMChannel>(`/dm-channels/${dmChannelId}`);
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

  // HQ streaming (T4) — chat-gateway is the membership-gated front door for media-svc.
  /**
   * Mint a short-lived publish token for the channel's HQ stream. The caller
   * must be a member of the channel's guild and the channel must be a voice
   * channel. The returned `push_url` already carries the token.
   */
  getStreamToken(channelId: string, protocol: 'rtmp' | 'srt' = 'rtmp'): Promise<StreamTokenResponse> {
    return request<StreamTokenResponse>(`/channels/${channelId}/stream-token`, {
      method: 'POST',
      body: { protocol }
    });
  },
  /** WHEP playback URL for `userId`'s HQ stream in `channelId`. */
  getWhepUrl(channelId: string, userId: string): Promise<{ whep_url: string }> {
    return request<{ whep_url: string }>(
      `/channels/${channelId}/whep?user_id=${encodeURIComponent(userId)}`
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

  // Watch-Party chat (one chat per channel, ephemeral, 6h TTL).
  /** Post a message into the active watch-party chat. 410 if no party is running. */
  postWatchChat(channelId: string, content: string): Promise<{ id: string; created_at: string }> {
    return request<{ id: string; created_at: string }>(
      `/channels/${channelId}/watch-party/chat`,
      { method: 'POST', body: { content } }
    );
  },
  /** Backfill the watch-party chat (chronological order, oldest first). */
  getWatchChat(channelId: string, limit = 100): Promise<WatchChatMessage[]> {
    return request<WatchChatMessage[]>(
      `/channels/${channelId}/watch-party/chat?limit=${limit}`
    );
  }
};
