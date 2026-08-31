/**
 * Beschafft die Mitgliederliste, mit der ein Ablage-Kanal seine
 * Gruppensitzung wählt — die Guild-Mitgliedschaft gefiltert auf
 * `VIEW_CHANNEL`, nicht `PrivateGroupMember` (die es für Guild-Kanäle nicht
 * gibt).
 *
 * **Welche Routen das liefern** (nachgesehen, kein neuer Server-Endpunkt
 * nötig): `GET /guilds/{id}/members` (`chatApi.listMembers`), `GET
 * /guilds/{id}/roles` (`rolesApi.list`), `GET /guilds/{id}/member-roles`
 * (`rolesApi.bulkMemberRoles` — ein Aufruf für alle Mitglieder statt N+1)
 * und `GET /channels/{id}/permissions` (`overwritesApi.list`) für die
 * Kanal-Overwrites. Dieselben vier Aufrufe, mit denen
 * `permissions/kanalansicht.ts` die Admin-Rechteansicht füllt — kein
 * eigener „wer darf diesen Kanal sehen"-Endpunkt existiert serverseitig
 * (`permissions.py::members_who_can_view` ist intern, nur für den
 * @-Mention-Fanout). Die eigentliche Filterung übernimmt die reine
 * `sichtbareMitglieder` aus `kanalSichtbareMitglieder.ts`.
 *
 * **Bekannte Grenze, wie in `kanalansicht.ts`:** `listMembers` paginiert
 * nicht (Server-Vorgabe `limit=100`) — bei einer Guild mit mehr als 100
 * Mitgliedern ist die Liste unvollständig. Keine neue Lücke dieser Datei,
 * dieselbe wie in der bestehenden Admin-Rechteansicht; eine Behebung
 * (Pagination in `chatApi.listMembers`) ist ein eigener, hier nicht
 * gestellter Auftrag.
 */
import { chatApi } from '../../api/chat';
import { rolesApi, overwritesApi } from '../../api/roles';
import { toBitfield } from '../../permissions/bitfield';
import { sichtbareMitglieder } from './kanalSichtbareMitglieder';

/** User-IDs jedes Mitglieds, das den Kanal `kanalId` (in Guild `guildId`)
 *  gerade sehen darf — die Mitgliederliste für `sitzungWaehlen`. */
export async function kanalMitgliederMitSicht(
  guildId: string,
  kanalId: string
): Promise<string[]> {
  const [guild, mitglieder, rollen, rollenIdsJeMitglied, overwrites] = await Promise.all([
    chatApi.getGuild(guildId),
    chatApi.listMembers(guildId),
    rolesApi.list(guildId),
    rolesApi.bulkMemberRoles(guildId),
    overwritesApi.list(kanalId)
  ]);
  return sichtbareMitglieder({
    mitglieder: mitglieder.map((m) => ({
      userId: m.user_id,
      rollenIds: rollenIdsJeMitglied[m.user_id] ?? []
    })),
    rollen: rollen.map((r) => ({
      id: r.id,
      position: r.position,
      permissions: toBitfield(r.permissions),
      is_everyone: r.is_everyone
    })),
    overwrites: overwrites.map((o) => ({
      target_type: o.target_type,
      target_id: o.target_id,
      allow: toBitfield(o.allow),
      deny: toBitfield(o.deny)
    })),
    besitzerId: guild.owner_id
  });
}
