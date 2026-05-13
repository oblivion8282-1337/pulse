import { request } from './client';
import type { AcceptInviteResult, Channel, Guild, Invite, InvitePreview, Member, Message } from './types';
import type { StreamChannelState } from '$lib/stores/streamPresence.svelte';

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

  // Members
  addMember(guildId: string, userId: string): Promise<Member> {
    return request<Member>(`/guilds/${guildId}/members`, {
      method: 'POST',
      // Pass as string — snowflake IDs exceed 2^53 and Number() drops precision.
      body: { user_id: userId }
    });
  },
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
  getChannel(channelId: string): Promise<Channel> {
    return request<Channel>(`/channels/${channelId}`);
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
    opts: { nonce?: string; replyToId?: string | null } = {}
  ): Promise<Message> {
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content,
        nonce: opts.nonce ?? null,
        reply_to_id: opts.replyToId ?? null
      }
    });
  },
  editMessage(messageId: string, content: string): Promise<Message> {
    return request<Message>(`/messages/${messageId}`, {
      method: 'PATCH',
      body: { content }
    });
  },
  deleteMessage(messageId: string): Promise<void> {
    return request<void>(`/messages/${messageId}`, { method: 'DELETE' });
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
  /** Channels in the guild that currently have an active HQ stream — re-sync helper. */
  async getGuildStreamState(guildId: string): Promise<StreamChannelState[]> {
    const r = await request<{ stream_states: StreamChannelState[] }>(`/guilds/${guildId}/stream-state`);
    return r.stream_states ?? [];
  }
};
