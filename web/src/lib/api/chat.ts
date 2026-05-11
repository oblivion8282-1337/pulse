import { request } from './client';
import type { AcceptInviteResult, Channel, Guild, Invite, InvitePreview, Member, Message } from './types';

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
  postMessage(channelId: string, content: string, nonce?: string): Promise<Message> {
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, nonce: nonce ?? null }
    });
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
  }
};
