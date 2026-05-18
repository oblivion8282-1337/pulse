/**
 * Per-guild sound-override URLs.
 *
 * Hydrates from the ready frame (each guild carries `sound_overrides:
 * [{sound_id, url}]`) and refreshes on the `guild_sound_updated` WS
 * event. URLs are short-lived (30 min default presigned-GET TTL); the
 * engine doesn't notice the staleness because each HTMLAudioElement
 * caches the decoded data once loaded.
 *
 * Reset on signOut so a re-login doesn't replay another user's overrides
 * (the URLs are signed against the previous session's identity anyway).
 */

import { chatApi, type GuildSoundOverrideOut } from '$lib/api/chat';

class GuildSoundStore {
  /** Per-guild map: ``byGuild[guildId][soundId] = url``. An empty inner
   * object means "we know this guild, it has no overrides" — distinct
   * from the missing-guild case where the resolver falls back to the
   * static default. */
  byGuild = $state<Record<string, Record<string, string>>>({});

  seedFromReady(
    entries: { id: string; sound_overrides?: { sound_id: string; url: string }[] }[]
  ): void {
    const next: Record<string, Record<string, string>> = { ...this.byGuild };
    for (const e of entries) {
      const map: Record<string, string> = {};
      for (const ov of e.sound_overrides ?? []) {
        map[ov.sound_id] = ov.url;
      }
      next[e.id] = map;
    }
    this.byGuild = next;
  }

  /** Initialise an empty slot for a guild the user has just joined /
   * created (no overrides yet). Called from both the local-create and
   * the WS-side ``guild_member_added`` paths so the Sounds tab shows
   * "no overrides" instead of "loading" between event and refresh. */
  ensureSlot(guildId: string): void {
    if (this.byGuild[guildId] !== undefined) return;
    this.byGuild = { ...this.byGuild, [guildId]: {} };
  }

  async refresh(guildId: string): Promise<void> {
    try {
      const rows = await chatApi.listGuildSounds(guildId);
      this.applyList(guildId, rows);
    } catch {
      /* swallow — next event / reconnect will try again */
    }
  }

  applyList(guildId: string, rows: GuildSoundOverrideOut[]): void {
    const map: Record<string, string> = {};
    for (const r of rows) map[r.sound_id] = r.url;
    this.byGuild = { ...this.byGuild, [guildId]: map };
  }

  /** URL for ``soundId`` in the given guild, or ``null`` to fall back
   * to the bundled default. Returns ``null`` when there's no guild
   * context (DM / settings dialog) or the guild has no override. */
  urlFor(soundId: string, guildId: string | null | undefined): string | null {
    if (!guildId) return null;
    return this.byGuild[guildId]?.[soundId] ?? null;
  }

  remove(guildId: string): void {
    if (!(guildId in this.byGuild)) return;
    const next = { ...this.byGuild };
    delete next[guildId];
    this.byGuild = next;
  }

  clear(): void {
    this.byGuild = {};
  }
}

export const guildSounds = new GuildSoundStore();
