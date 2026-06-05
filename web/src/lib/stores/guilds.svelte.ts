import { chatApi } from '$lib/api/chat';
import type { Channel, Guild } from '$lib/api/types';

class GuildStore {
  byId = $state<Record<string, Guild>>({});
  channelsByGuild = $state<Record<string, Channel[]>>({});
  loaded = $state(false);
  // In-flight `listChannels` calls keyed by guild id. Lets `ensureChannels`
  // dedupe a prefetch + a concurrent click-driven load into a single
  // round-trip.
  #channelLoads = new Map<string, Promise<Channel[]>>();
  // Reverse index: channelId → guildId for O(1) lookups.
  private channelToGuild = $state<Map<string, string>>(new Map());

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

  /** Force-refresh: always fires `GET /channels`. Use for explicit "I want
   * fresh data" paths (`channel_*` lifecycle events keep the cache live
   * during a connected session, so this is rarely the right choice — prefer
   * ``ensureChannels``). */
  async loadChannels(guildId: string): Promise<Channel[]> {
    const channels = await chatApi.listChannels(guildId);
    this.channelsByGuild = { ...this.channelsByGuild, [guildId]: channels };
    // Keep the reverse index in sync — without this, `guildIdForChannel`
    // returns null for every bulk-loaded channel (only the WS-lifecycle
    // `addChannel`/`updateChannel` paths populated it). That silently
    // drops the guild context on sound playback: per-guild overrides are
    // never consulted, and stream sounds (which have no bundled fallback)
    // go completely silent.
    for (const c of channels) this.channelToGuild.set(c.id, guildId);
    return channels;
  }

  /** Cached + deduped variant. Returns the cached list if we already have
   * one; otherwise fires a single `listChannels` (or attaches to the
   * in-flight one). Used by the post-Ready prefetch and by `switchTo`. */
  async ensureChannels(guildId: string): Promise<Channel[]> {
    const cached = this.channelsByGuild[guildId];
    if (cached) return cached;
    const inflight = this.#channelLoads.get(guildId);
    if (inflight) return inflight;
    const p = this.loadChannels(guildId).finally(() => {
      this.#channelLoads.delete(guildId);
    });
    this.#channelLoads.set(guildId, p);
    return p;
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

  /** Find the guild containing ``channelId``. Returns ``null`` for DM
   * channels and unknown ids. Uses a reverse index for O(1) lookup. */
  guildIdForChannel(channelId: string): string | null {
    return this.channelToGuild.get(channelId) ?? null;
  }

  remove(guildId: string): void {
    if (!this.byId[guildId]) return;
    const nextById = { ...this.byId };
    delete nextById[guildId];
    this.byId = nextById;
    const nextChannels = { ...this.channelsByGuild };
    // Drop the guild's channels from the reverse index too, so a later
    // `guildIdForChannel` for a now-orphaned channel id can't return a
    // stale guild (now that `loadChannels` actually populates the index).
    for (const c of nextChannels[guildId] ?? []) this.channelToGuild.delete(c.id);
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
    // Update reverse index.
    this.channelToGuild.set(channel.id, channel.guild_id);
  }

  removeChannel(channelId: string): void {
    // Use reverse index to find and update only the affected guild.
    const guildId = this.channelToGuild.get(channelId);
    if (!guildId) return;
    const list = this.channelsByGuild[guildId];
    if (!list) return;
    const filtered = list.filter((c) => c.id !== channelId);
    if (filtered.length === list.length) return; // Channel not found.
    this.channelsByGuild = {
      ...this.channelsByGuild,
      [guildId]: filtered
    };
    this.channelToGuild.delete(channelId);
  }

  updateChannel(channel: Partial<Channel> & Pick<Channel, 'id' | 'guild_id'>): void {
    const list = this.channelsByGuild[channel.guild_id];
    if (!list) return;
    this.channelsByGuild = {
      ...this.channelsByGuild,
      // Merge so fields the event omits (e.g. created_at) keep their values.
      [channel.guild_id]: list.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
    };
    // Ensure reverse index is up-to-date.
    this.channelToGuild.set(channel.id, channel.guild_id);
  }

  clear(): void {
    this.byId = {};
    this.channelsByGuild = {};
    this.loaded = false;
    this.#channelLoads.clear();
    this.channelToGuild.clear();
  }
}

export const guilds = new GuildStore();
