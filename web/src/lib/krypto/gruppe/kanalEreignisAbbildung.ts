/**
 * Bildet ein rohes WS-Ereignis (`ServerEvent`) auf `KanalWechselEreignis`
 * ab — die Verdrahtungsstelle, die `kanalWechselErkennung.ts`s Modulkopf
 * ankündigt: „die echten Ereignisse erfüllen diese Form strukturell — kein
 * Adapter nötig, nur bei `role_updated`/`role_created` liegt `guild_id` im
 * echten Ereignis unter `role.guild_id` und muss beim Verdrahten (Aufgabe 5)
 * einmal umgehängt werden."
 *
 * `role_created` selbst macht KEINEN Kanal überholt (eine neue Rolle hat
 * noch niemanden zugewiesen und keine Overwrites) und fehlt deshalb bewusst
 * in `KanalWechselEreignis` — nur `role_updated`/`role_deleted` stehen dort
 * (s. `kanalWechselErkennung.ts`-Modulkopf). Alles andere liefert `null`:
 * kein Ereignis, das eine Kanal-Sitzung überholt machen könnte.
 *
 * **Importfrei bleibt diese Datei NICHT** (anders als `kanalWechselErkennung.ts`)
 * — sie ist reine Verdrahtung zwischen zwei bereits bestehenden Typen und
 * wird nicht vom Node-Testläufer erfasst (`pnpm test:unit`s Glob ist
 * `web/test/*.test.ts`, kein Test importiert diese Datei).
 */
import type { ServerEvent } from '$lib/ws/handlers/types';
import type { KanalWechselEreignis } from './kanalWechselErkennung';

export function kanalWsEreignisAbbilden(evt: ServerEvent): KanalWechselEreignis | null {
  switch (evt.op) {
    case 'guild_member_added':
      return { op: 'guild_member_added', guild_id: evt.guild_id };
    case 'guild_member_removed':
      return { op: 'guild_member_removed', guild_id: evt.guild_id };
    case 'member_roles_updated':
      return { op: 'member_roles_updated', guild_id: evt.guild_id };
    case 'role_updated':
      return { op: 'role_updated', guild_id: evt.role.guild_id };
    case 'role_deleted':
      return { op: 'role_deleted', guild_id: evt.guild_id };
    case 'channel_permissions_updated':
      return {
        op: 'channel_permissions_updated',
        guild_id: evt.guild_id,
        channel_id: evt.channel_id
      };
    default:
      return null;
  }
}
