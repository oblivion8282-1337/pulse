/**
 * Vom Entwurf zum Auflösungsziel — die Rechenvorbereitung der Ansicht.
 *
 * **Der Entwurf muss mitgerechnet werden.** Die Ergebnis-Spalte soll zeigen,
 * was nach dem Speichern gilt, nicht was vor der letzten Änderung galt. Also
 * gehen nicht die gespeicherten Überschreibungen in den Resolver, sondern die
 * gespeicherten MIT dem Entwurf darübergelegt.
 *
 * **Eine Rolle als Ziel ist ein nachgestelltes Mitglied.** Rollen lassen sich
 * nicht „auflösen" — Rechte hat immer eine Person. Für die Zeile „Moderation in
 * #werkstatt" wird deshalb jemand gedacht, der genau `@everyone` und
 * `Moderation` trägt: das ist der Normalfall und lässt sich mit demselben
 * Resolver rechnen, statt eine zweite Formel für Rollen zu erfinden.
 *
 * Hier liegt auch das Laden der Mitglieder samt ihrer Rollen: beide Reiter
 * („Rechte" und „Prüfen") brauchen genau dasselbe Paar, und zweimal
 * ausgeschrieben wären es auch zwei Stellen, an denen ein Fehlschlag anders
 * behandelt würde.
 */

import { chatApi } from '$lib/api/chat';
import { rolesApi, type Overwrite, type Role } from '$lib/api/roles';
import type { Member } from '$lib/api/types';
import { guilds } from '$lib/stores/guilds.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { userCache } from '$lib/stores/users.svelte';
import type { KanalEntwurf } from './entwurf.svelte';
import type { Aufloesungsziel, BenanntesOverwrite } from './herkunft';
import { alsBenannteRolle, benannteRollen, teileSchluessel, zielSchluessel } from './schnappschuesse';

/** Mitglieder der Community und ihre Rollen-IDs. Ein Fehlschlag lässt die
 *  Ansicht leer stehen statt sie abzubrechen — sie ist dann nur ärmer. */
export async function mitgliederUndRollen(
  guildId: string
): Promise<{ mitglieder: Member[]; rollenIdsJeMitglied: Record<string, string[]> }> {
  let mitglieder: Member[] = [];
  let rollenIdsJeMitglied: Record<string, string[]> = {};
  try {
    mitglieder = await chatApi.listMembers(guildId);
    for (const mem of mitglieder) userCache.queue(mem.user_id);
  } catch {
    mitglieder = [];
  }
  try {
    rollenIdsJeMitglied = await rolesApi.bulkMemberRoles(guildId);
  } catch {
    rollenIdsJeMitglied = {};
  }
  return { mitglieder, rollenIdsJeMitglied };
}

/** Gespeicherte Abweichungen mit dem Entwurf darüber — inklusive der Ziele,
 *  die es auf dem Server noch gar nicht gibt. */
export function wirkendeAbweichungen(
  overwrites: readonly Overwrite[],
  entwurf: KanalEntwurf,
  name: (key: string) => string
): BenanntesOverwrite[] {
  const gespeicherte = overwrites.map(zielSchluessel);
  const bekannt = new Set(gespeicherte);
  const nurImEntwurf = Object.keys(entwurf.aenderungen).filter((key) => !bekannt.has(key));
  return [...gespeicherte, ...nurImEntwurf].map((key) => {
    const { art, id } = teileSchluessel(key);
    const p = entwurf.stand(key);
    return {
      target_type: art,
      target_id: id,
      allow: p.allow,
      deny: p.deny,
      name: name(key)
    };
  });
}

export function zielAufloesung(args: {
  /** `<art>:<id>` des betrachteten Ziels. */
  key: string;
  guildId: string;
  rollen: readonly Role[];
  /** Rollen-IDs je Mitglied (aus `rolesApi.bulkMemberRoles`). */
  rollenIdsJeMitglied: Record<string, string[]>;
  besitzerId: string | null;
  abweichungen: BenanntesOverwrite[];
}): Aufloesungsziel {
  const { art, id } = teileSchluessel(args.key);
  if (art === 0) {
    const everyone = args.rollen.find((r) => r.is_everyone);
    const rolle = args.rollen.find((r) => r.id === id);
    const gedacht: Role[] = [];
    if (everyone) gedacht.push(everyone);
    if (rolle && !rolle.is_everyone) gedacht.push(rolle);
    return {
      // Leere Nutzerkennung: für eine Rolle darf keine Mitglieds-Abweichung
      // greifen — es gibt kein Mitglied, dem sie gehörte.
      userId: '',
      isMember: true,
      isOwner: false,
      rollen: gedacht.map(alsBenannteRolle),
      overwrites: args.abweichungen,
      eigenerSchluessel: args.key
    };
  }
  return {
    userId: id,
    isMember: true,
    isOwner: args.besitzerId === id,
    rollen: benannteRollen(args.guildId, new Set(args.rollenIdsJeMitglied[id] ?? [])),
    overwrites: args.abweichungen,
    eigenerSchluessel: args.key
  };
}

/** Eigentümer-Kennung der Community — erst aus den geladenen Guilds, sonst aus
 *  dem Serververzeichnis (Fremde Communities stehen nur dort). Stand doppelt in
 *  `ChannelOverridesEditor` und `PruefenAnsicht`, beide brauchen ihn für
 *  dieselbe Besitzer-Prüfung im Resolver. */
export function besitzerId(guildId: string): string | null {
  return guilds.byId[guildId]?.owner_id ?? serverGuilds.findGuild(guildId)?.owner_id ?? null;
}
