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

  addChannel(channel: Channel): void {
    const list = this.channelsByGuild[channel.guild_id] ?? [];
    if (list.some((c) => c.id === channel.id)) return;
    this.channelsByGuild = {
      ...this.channelsByGuild,
      [channel.guild_id]: [...list, channel]
    };
  }

  clear(): void {
    this.byId = {};
    this.channelsByGuild = {};
    this.loaded = false;
  }
}

export const guilds = new GuildStore();
