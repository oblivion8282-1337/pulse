/**
 * Per-guild sound-override URLs.
 *
 * Hydrates from the ready frame (each guild carries `sound_overrides:
 * [{sound_id, url}]`) and refreshes on the `guild_sound_updated` WS
 * event. URLs are SHORT-LIVED presigned GETs (server default
 * `s3_presigned_ttl_seconds = 600` — 10 Minuten) und werden deshalb
 * altersbewusst ausgeliefert: ``urlFor`` behandelt Einträge nach einer
 * Sicherheitsmarge als veraltet, spielt sie nicht mehr an und stößt
 * nebenbei ``refresh`` an. Ohne das Fürsorge-Paket (2026-08-30) war der
 * Cue ~10 Minuten nach Seitenladen eine Lotterie, die in Dauer-Schweigen
 * kippte: ein neu gebautes Audio-Element fetcht die abgelaufene URL
 * (403 → still), während alte Pool-Elemente aus ihrem Puffer weiter
 * funktionierten.
 *
 * Reset on signOut so a re-login doesn't replay another user's overrides
 * (the URLs are signed against the previous session's identity anyway).
 */

import { chatApi, type GuildSoundOverrideOut } from '$lib/api/chat';

/** Server-Default: `s3_presigned_ttl_seconds = 600` (config.py). Mit Sicherheits-
 *  margin wird ein Eintrag schon nach 8 Minuten als reif fürs Erneuern
 *  behandelt — ein evtl. verpasster Cue ist unsichtbar gegen den
 *  Dauer-Ausfall nach echter Ablaufzeit. */
const REFRESH_AFTER_S = 480;

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
   *  gebündelte Default). Zwei Fälle liefern null: kein Guild-Kontext,
   *  oder der Eintrag ist älter als die Presign-Sicherheitsmarge — dann
   *  wird zugleich ein Refresh angestoßen, sodass der nächste Play eine
   *  frische Signatur bekommt. */
  urlFor(soundId: string, guildId: string | null | undefined): string | null {
    if (!guildId) return null;
    const url = this.byGuild[guildId]?.[soundId] ?? null;
    if (url === null) return null;
    const fetched = this.fetchedAt.get(guildId) ?? 0;
    if ((Date.now() - fetched) / 1000 > REFRESH_AFTER_S) {
      void this.refresh(guildId);
      return null;
    }
    return url;
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
