/**
 * **Reine Entscheidung: macht ein WS-Ereignis die laufende Gruppensitzung
 * eines Ablage-Kanals potenziell überholt?**
 *
 * Private Gruppen haben kein Ereignis über einen Mitgliederwechsel
 * (`sitzungswahl.ts`-Modulkopf) und lesen deshalb vor JEDER Sendung neu.
 * Guild-Kanäle haben stattdessen echte WS-Ereignisse für Mitglieder- und
 * Rechteänderungen — bei vielen Mitgliedern wäre ein `GET` plus
 * `keys/claim` je Nachricht der falsche Weg (E6-Plan, Entscheidung 2).
 * Diese Datei entscheidet nur, OB ein Ereignis den Kanal betrifft; das
 * Markieren als überholt und das eigentliche Neuholen der Mitgliederliste
 * liegen in `kanalSitzungswahl.ts`.
 *
 * **Importfrei** (CLAUDE.md „Die Falle" — Nodes Testläufer löst
 * erweiterungslose Laufzeit-Importe nicht auf): ein eigenes, strukturelles
 * Abbild der relevanten WS-Ereignisse statt ein Import aus
 * `web/src/lib/ws/handlers/types.ts`. Die echten Ereignisse erfüllen diese
 * Form strukturell — kein Adapter nötig, nur bei `role_updated`/
 * `role_created` liegt `guild_id` im echten Ereignis unter `role.guild_id`
 * und muss beim Verdrahten (Aufgabe 5) einmal umgehängt werden.
 *
 * **Welche Ereignisse, und warum genau diese** (nachgesehen in
 * `services/chat-gateway/src/dcc_chat_gateway/routes/role_members.py`,
 * `routes/guilds.py`, `routes/permission_overwrites.py` und
 * `shared/src/dcc_shared/events/guild.py`):
 *
 * - `guild_member_added` / `guild_member_removed` — die Mitgliedermenge
 *   selbst ändert sich.
 * - `member_roles_updated` — ein Mitglied bekommt/verliert eine Rolle, die
 *   `VIEW_CHANNEL` tragen kann.
 * - `role_updated` / `role_deleted` — die Rolle selbst ändert ihre
 *   Berechtigungsbits oder verschwindet; betrifft potenziell jedes
 *   Mitglied, das sie trägt.
 * - `channel_permissions_updated` — ein Overwrite auf GENAU diesem Kanal
 *   ändert sich.
 *
 * `guild_ban_added`/`guild_membership_revoked` fehlen bewusst: ein Bann
 * kickt zuerst (`guild_member_removed` feuert immer mit), es gibt keinen
 * Fall, in dem nur der Bann allein die Sicht auf den Kanal ändert.
 *
 * **Bewusst grobkörnig, nicht kanalscharf, bei den guild-weiten
 * Ereignissen.** Ob eine Rollenrechte-Änderung wirklich GENAU diesen Kanal
 * trifft, ist ohne die volle Rechteauflösung nicht günstig zu entscheiden
 * (dieselbe Lage wie beim serverseitigen `evict_ineligible_from_voice_channels`,
 * das aus demselben Grund guild-weit statt kanalweise nachzieht). Zu oft
 * überholt zu markieren kostet nur eine zusätzliche Mitgliederliste vor der
 * nächsten Sendung — zu selten kostet eine Aussperrung, die nicht
 * stattfindet. Die Wahl fällt deshalb immer auf „lieber einmal zu viel".
 */

/** Strukturelles Abbild der WS-Ereignisse, die eine Kanal-Sitzung überholt
 *  machen können — siehe Modulkopf für die Begründung je Fall. */
export type KanalWechselEreignis =
  | { op: 'guild_member_added'; guild_id: string }
  | { op: 'guild_member_removed'; guild_id: string }
  | { op: 'member_roles_updated'; guild_id: string }
  | { op: 'role_updated'; guild_id: string }
  | { op: 'role_deleted'; guild_id: string }
  | { op: 'channel_permissions_updated'; guild_id: string; channel_id: string };

/**
 * `true`, wenn `evt` die Sitzung des Kanals `kanalId` (in Guild `guildId`)
 * überholt machen KANN. Sagt nichts darüber aus, ob sich die tatsächliche
 * `VIEW_CHANNEL`-Menge geändert hat — das entscheidet erst der Vergleich in
 * `sitzungswahl.ts::wechselgrund`, sobald die frische Mitgliederliste da
 * ist.
 */
export function machtKanalUeberholt(
  evt: KanalWechselEreignis,
  guildId: string,
  kanalId: string
): boolean {
  if (evt.guild_id !== guildId) return false;
  if (evt.op === 'channel_permissions_updated') return evt.channel_id === kanalId;
  return true;
}
