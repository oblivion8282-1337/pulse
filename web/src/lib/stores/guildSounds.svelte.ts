/**
 * Per-guild sound-override URLs.
 *
 * Hydrates from the ready frame (each guild carries `sound_overrides:
 * [{sound_id, url}]`) and refreshes on the `guild_sound_updated` WS
 * event. URLs are SHORT-LIVED presigned GETs (server default
 * `s3_presigned_ttl_seconds = 1800` — 30 Minuten) und werden deshalb
 * altersbewusst ausgeliefert: ab 8 Minuten läuft nebenbei ein ``refresh``,
 * gespielt wird aber weiterhin — solange die Signatur nachweislich reicht
 * (`sounds/frische.ts`). Die alte „nach 8 Minuten null"-Regel (Fürsorge-
 * Paket 2026-08-30) baute Dauer-Schweigen im 8-Minuten-Rhythmus, wenn der
 * Fallback-Klang fehlte (Stream-Klänge waren nicht gebündelt — Fund
 * 2026-10-06). Reset on signOut so a re-login doesn't replay another
 * user's overrides (the URLs are signed against the previous session's
 * identity anyway).
 */

import { chatApi, type GuildSoundOverrideOut } from '$lib/api/chat';
import { klangLinkUrteil } from '$lib/sounds/frische';

class GuildSoundStore {
  /** Per-guild map: ``byGuild[guildId][soundId] = url``. An empty inner
   * object means "we know this guild, it has no overrides" — distinct
   * from the missing-guild case where the resolver falls back to the
   * static default. */
  byGuild = $state<Record<string, Record<string, string>>>({});
  /** Wann die URL-Liste je Guild zuletzt (frisch) geholt wurde. Kein
   *  $state — rein technisches Buchhalten wie messages.accessOrder. */
  private fetchedAt = new Map<string, number>();
  /** Laufende Refreshes je Guild — verhindert Stampede bei mehreren
   *  Plays im veralteten Fenster. */
  private refreshing = new Set<string>();

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
      this.fetchedAt.set(e.id, Date.now());
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
    this.fetchedAt.set(guildId, Date.now());
  }

  async refresh(guildId: string): Promise<void> {
    if (this.refreshing.has(guildId)) return;
    this.refreshing.add(guildId);
    try {
      const rows = await chatApi.listGuildSounds(guildId);
      this.applyList(guildId, rows);
    } catch {
      /* swallow — next event / reconnect / stale-read will try again */
    } finally {
      this.refreshing.delete(guildId);
    }
  }

  applyList(guildId: string, rows: GuildSoundOverrideOut[]): void {
    const map: Record<string, string> = {};
    for (const r of rows) map[r.sound_id] = r.url;
    this.byGuild = { ...this.byGuild, [guildId]: map };
    this.fetchedAt.set(guildId, Date.now());
  }

  /** URL für ``soundId`` in der Guild — oder ``null`` (Fallback aufs
   *  gebündelte Default). ``null`` nur noch, wenn die Signatur wirklich am
   *  Ende ist; sonst spielt der Link weiter und die Erneuerung läuft
   *  nebenbei (8-Minuten-Stille-Fehler 2026-10-06, siehe frische.ts). */
  urlFor(soundId: string, guildId: string | null | undefined): string | null {
    if (!guildId) return null;
    const url = this.byGuild[guildId]?.[soundId] ?? null;
    if (url === null) return null;
    const fetched = this.fetchedAt.get(guildId) ?? 0;
    const { spielen, erneuern } = klangLinkUrteil((Date.now() - fetched) / 1000);
    if (erneuern) void this.refresh(guildId);
    return spielen ? url : null;
  }

  remove(guildId: string): void {
    if (!(guildId in this.byGuild)) return;
    const next = { ...this.byGuild };
    delete next[guildId];
    this.byGuild = next;
    this.fetchedAt.delete(guildId);
  }

  clear(): void {
    this.byGuild = {};
    this.fetchedAt.clear();
  }
}

export const guildSounds = new GuildSoundStore();
