/**
 * Wer darf in diesem Kanal fernsteuern? — die Auflösung der abstrakten Regel.
 *
 * **Warum es das gibt.** Die Dauerfreigabe kennt eine weite Einstellung: „jeder
 * mit dem Recht zur Fernsteuerung". Das ist wahr, aber leer — im Gerätedialog
 * stand damit ein Satz über eine Regel, die woanders gepflegt wird, und der
 * Besitzer setzte einen Haken, ohne zu wissen, ob er damit drei Leute meint oder
 * die halbe Community. Genau diese Lücke schliesst dieses Modul: es rechnet die
 * Regel in eine **Zahl** um, die man prüfen kann.
 *
 * **Gerechnet wird mit dem vorhandenen Resolver** (`permissions/bitfield.ts`),
 * demselben, mit dem der Client seine eigenen Rechte auflöst — hier nur für
 * fremde Mitglieder statt für sich selbst. Ein zweiter Nachbau der Formel wäre
 * genau die Doppelung, vor der `CLAUDE.md` warnt: der Server ist die Wahrheit,
 * und eine abweichende Kopie fällt erst auf, wenn sie jemandem zu viel erlaubt.
 * Die Umwandlung Store/Wire → Resolver liegt seit der neuen Kanalrechte-Ansicht
 * in `permissions/schnappschuesse.ts` und wird von beiden Stellen benutzt.
 *
 * **Was die Zahl NICHT sieht** (und warum sie eine Untergrenze ist): ob ein
 * Mitglied Instanz-Administrator ist, steht nur in dessen eigener Sitzung —
 * fremde Admin-Flags kennt kein Client. Admins lösen serverseitig auf
 * `GRANT_ALL_SAFE` auf, dürfen also immer. Die Anzeige sagt deshalb „mindestens",
 * nicht „genau". Der Besitzer des Servers ist bekannt und wird mitgezählt.
 */

import { overwritesApi, rolesApi } from '$lib/api/roles';
import { guilds } from '$lib/stores/guilds.svelte';
import { Perm, has, resolveChannelPermissions } from '$lib/permissions/bitfield';
import { benannteRollen, overwriteSchnappschuesse } from '$lib/permissions/schnappschuesse';

/**
 * Wie viele Mitglieder dieser Community dürfen im Kanal fernsteuern?
 *
 * Ein Abruf je Aufruf (Rollen aller Mitglieder + Überschreibungen des Kanals) —
 * gedacht für den Moment, in dem jemand den Gerätedialog öffnet, nicht für eine
 * laufende Anzeige.
 */
export async function anzahlBerechtigte(
  guildId: string,
  channelId: string,
  mitgliedIds: string[],
): Promise<number> {
  const [bulk, roh] = await Promise.all([
    rolesApi.bulkMemberRoles(guildId),
    overwritesApi.list(channelId),
  ]);
  const overwrites = overwriteSchnappschuesse(roh);
  const besitzer = guilds.byId[guildId]?.owner_id ?? null;

  let zahl = 0;
  for (const userId of mitgliedIds) {
    const wert = resolveChannelPermissions({
      // Fremde Admin-Flags sind hier nicht bekannt (s. Modulkopf) — die Zahl
      // ist deshalb eine Untergrenze, keine Behauptung über jeden Einzelnen.
      isGlobalAdmin: false,
      isOwner: besitzer === userId,
      isMember: true,
      userId,
      roles: benannteRollen(guildId, new Set(bulk[userId] ?? [])),
      overwrites,
    });
    if (has(wert, Perm.REMOTE_CONTROL)) zahl += 1;
  }
  return zahl;
}
