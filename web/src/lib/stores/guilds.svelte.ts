import { chatApi } from '$lib/api/chat';
import type { Channel, Guild } from '$lib/api/types';

class GuildStore {
  byId = $state<Record<string, Guild>>({});
  channelsByGuild = $state<Record<string, Channel[]>>({});
  loaded = $state(false);

  get list(): Guild[] {
    return Object.values(this.byId).sort((a, b) => Number(a.id) - Number(b.id));
  }

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
}

export const guilds = new GuildStore();
