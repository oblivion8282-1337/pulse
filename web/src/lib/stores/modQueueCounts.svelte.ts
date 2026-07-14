/**
 * Offene-Meldungen-Zähler pro Community (Moderator-Badge).
 *
 * Push-getrieben, nicht gepollt: einmal beim `ready` hydriert (für jede Guild,
 * in der der User moderiert), danach live per `report_new`-WS-Ereignis erhöht
 * und nach Mod-Aktionen (resolve/dismiss/triage) via {@link refresh} neu geladen.
 *
 * Der Zähler zählt offene Meldungen (Status `new` + `triaged`) — identisch zur
 * Serverseite (`GET /guilds/{id}/mod-queue/count`), damit Badge und die zwei
 * offenen Tabs der Mod-Queue nie auseinanderlaufen.
 *
 * Hydrierung/Leeren folgt der Store-Konvention (siehe multi-server-reset):
 * `ready` befüllt, `resetServerScopedStores()` leert bei Sign-Out/Server-Wechsel.
 */

import { getModQueueCount } from '$lib/api/moderation';

class ModQueueCounts {
  /** guildId → Anzahl offener Meldungen. Nur Guilds, in denen der User
   *  moderiert, haben einen Eintrag (0 ist ein gültiger, sichtbarer Wert). */
  openCountByGuild = $state<Record<string, number>>({});

  get(guildId: string): number {
    return this.openCountByGuild[guildId] ?? 0;
  }

  set(guildId: string, n: number): void {
    this.openCountByGuild[guildId] = Math.max(0, n);
  }

  increment(guildId: string): void {
    this.openCountByGuild[guildId] = this.get(guildId) + 1;
  }

  clear(): void {
    this.openCountByGuild = {};
  }

  /** Zähler einer Guild frisch vom Server holen. Fehler (transient / keine
   *  Mod-Rechte → 403) werden verschluckt — der alte Stand bleibt stehen. */
  async refresh(guildId: string): Promise<void> {
    try {
      this.set(guildId, await getModQueueCount(guildId));
    } catch {
      /* transient / nicht mehr Mod → nächster Trigger korrigiert */
    }
  }

  /** Initiale Befüllung beim `ready`: parallel für alle Guilds, in denen der
   *  User moderiert. Nicht-Mod-Guilds werden nicht abgefragt (sie würden 403). */
  async hydrate(modGuildIds: string[]): Promise<void> {
    await Promise.all(modGuildIds.map((id) => this.refresh(id)));
  }
}

export const modQueueCounts = new ModQueueCounts();
