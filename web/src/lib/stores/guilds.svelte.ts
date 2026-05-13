import { chatApi } from '$lib/api/chat';
import type { Channel, Guild } from '$lib/api/types';

class GuildStore {
  byId = $state<Record<string, Guild>>({});
  channelsByGuild = $state<Record<string, Channel[]>>({});
  loaded = $state(false);

  // Snowflake IDs have the same length, so lexicographic order == numeric order.
  // Avoids Number() precision loss for IDs > 2^53.
  list = $derived(
    Object.values(this.byId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  );

  async hydrate(): Promise<void> {
    const guilds = await chatApi.listGuilds();
    const next: Record<string, Guild> = {};
    for (const g of guilds) next[g.id] = g;
    this.byId = next;
    this.loaded = true;
  }

  async loadChannels(guildId: string): Promise<Channel[]> {
    const channels = await chatApi.listChannels(guildId);
    this.channelsByGuild = { ...this.channelsByGuild, [guildId]: channels };
    return channels;
  }

  add(guild: Guild): void {
    this.byId = { ...this.byId, [guild.id]: guild };
  }

  updateGuild(guild: Partial<Guild> & Pick<Guild, 'id'>): void {
    const existing = this.byId[guild.id];
    if (!existing) return;
    // Merge so fields the lifecycle envelope omits (e.g. created_at) survive.
    this.byId = { ...this.byId, [guild.id]: { ...existing, ...guild } };
  }

  remove(guildId: string): void {
    if (!this.byId[guildId]) return;
    const nextById = { ...this.byId };
    delete nextById[guildId];
    this.byId = nextById;
    const nextChannels = { ...this.channelsByGuild };
    delete nextChannels[guildId];
    this.channelsByGuild = nextChannels;
  }

  addChannel(channel: Partial<Channel> & Omit<Channel, 'created_at'>): void {
    const list = this.channelsByGuild[channel.guild_id] ?? [];
    if (list.some((c) => c.id === channel.id)) return;
    // WS lifecycle events omit created_at; it's not surfaced in the channel
    // list, so fall back to "now" rather than carrying it through the wire.
    const full: Channel = { created_at: new Date().toISOString(), ...channel };
    this.channelsByGuild = {
      ...this.channelsByGuild,
      [channel.guild_id]: [...list, full]
    };
  }

  removeChannel(channelId: string): void {
    const next: Record<string, Channel[]> = {};
    for (const [gid, list] of Object.entries(this.channelsByGuild)) {
      next[gid] = list.filter((c) => c.id !== channelId);
    }
    this.channelsByGuild = next;
  }

  updateChannel(channel: Partial<Channel> & Pick<Channel, 'id' | 'guild_id'>): void {
    const list = this.channelsByGuild[channel.guild_id];
    if (!list) return;
    this.channelsByGuild = {
      ...this.channelsByGuild,
      // Merge so fields the event omits (e.g. created_at) keep their values.
      [channel.guild_id]: list.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
    };
  }

  clear(): void {
    this.byId = {};
    this.channelsByGuild = {};
    this.loaded = false;
  }
}

export const guilds = new GuildStore();
