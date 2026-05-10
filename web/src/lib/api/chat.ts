import { request } from './client';
import type { Channel, Guild, Member, Message } from './types';

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
      body: { user_id: Number(userId) }
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
  }
};
