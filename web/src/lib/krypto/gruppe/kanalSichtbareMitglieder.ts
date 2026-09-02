/**
 * Reine Rechnung: welche Guild-Mitglieder halten `VIEW_CHANNEL` auf einem
 * bestimmten Kanal?
 *
 * Für einen Ablage-Kanal ist DAS die Mitgliedermenge einer Gruppensitzung —
 * nicht `PrivateGroupMember` (die Tabelle gibt es für Guild-Kanäle gar
 * nicht) und nicht die volle Guild-Mitgliederliste (die enthält auch
 * Leute, denen der Kanal per Overwrite entzogen ist).
 *
 * Getrennt von der I/O-Beschaffung (`kanalMitglieder.ts`), damit die
 * eigentliche Auflösung ohne Netz/IndexedDB prüfbar bleibt — importfrei,
 * einziger Bezug ist der ebenfalls importfreie Bitfield-Resolver
 * `permissions/bitfield.ts` (TS-Spiegel des Server-Resolvers, mit dem auch
 * `permissions/kanalansicht.ts` rechnet).
 */
import {
  resolveChannelPermissions,
  has,
  Perm,
  type RoleSnapshot,
  type OverwriteSnapshot
} from '../../permissions/bitfield.ts';

export type KanalMitgliedRohdaten = {
  userId: string;
  /** Rollen-IDs dieses Mitglieds (ohne `@everyone` — die wird separat
   *  ergänzt, wie im Server-Resolver und in `kanalansicht.ts`). */
  rollenIds: string[];
};

/**
 * Liefert die User-IDs jedes Mitglieds, das den Kanal gerade sehen darf.
 *
 * **Bekannte Lücke, wie im Server-Original** (`permissions.py::
 * members_who_can_view`): der globale Admin-Status eines FREMDEN Mitglieds
 * ist hier nicht bekannt (er liegt im auth-svc/JWT, nicht in dieser
 * Guild-Momentaufnahme) — ein globaler Admin ohne rollenbasiertes
 * `VIEW_CHANNEL` fehlt deshalb in der Rückgabe. Selten und nicht
 * sicherheitskritisch für den Zweck hier (Verteilkreis einer
 * Gruppensitzung): ein übersehener Admin bekommt den Sitzungsschlüssel
 * einfach erst bei der nächsten Rotation, keine Nachricht wird ihm
 * fälschlich zugestellt.
 */
export function sichtbareMitglieder(args: {
  mitglieder: KanalMitgliedRohdaten[];
  rollen: RoleSnapshot[];
  overwrites: OverwriteSnapshot[];
  besitzerId: string | null;
}): string[] {
  const rollenNachId = new Map(args.rollen.map((r) => [r.id, r] as const));
  const everyoneRollen = args.rollen.filter((r) => r.is_everyone);

  const out: string[] = [];
  for (const mitglied of args.mitglieder) {
    if (args.besitzerId !== null && args.besitzerId === mitglied.userId) {
      // Owner resolved beim echten Resolver auf GRANT_ALL, unabhaengig von
      // Rollen/Overwrites — direkt uebernehmen statt den Resolver mit
      // isOwner:true nur dafuer aufzurufen.
      out.push(mitglied.userId);
      continue;
    }
    const eigeneRollen: RoleSnapshot[] = [...everyoneRollen];
    for (const rid of mitglied.rollenIds) {
      const rolle = rollenNachId.get(rid);
      if (rolle && !rolle.is_everyone) eigeneRollen.push(rolle);
    }
    const wert = resolveChannelPermissions({
      isGlobalAdmin: false,
      isOwner: false,
      isMember: true,
      userId: mitglied.userId,
      roles: eigeneRollen,
      overwrites: args.overwrites
    });
    if (has(wert, Perm.VIEW_CHANNEL)) out.push(mitglied.userId);
  }
  return out;
}
