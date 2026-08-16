/**
 * Wer traegt welche Rolle — einmal geladen, dreifach gebraucht.
 *
 * Die Rangleiter zeigt je Zeile die Anzahl, der Reiter „Mitglieder" die
 * Traeger als Chips, und die Loeschrueckfrage muss sagen, wie viele
 * Menschen die Rolle verlieren. Drei Fragen, eine Antwort: ein einziger
 * `rolesApi.bulkMemberRoles`-Aufruf statt `listMemberRoles` je Mitglied.
 *
 * Scheitert der Aufruf, bleibt `geladen` falsch und alle Zaehler geben
 * `null` — die Bedienoberflaeche zeigt dann KEINE Zahl. Eine geratene Zahl
 * in einer Loeschrueckfrage waere schlimmer als gar keine.
 */

import { chatApi } from '$lib/api/chat';
import { rolesApi } from '$lib/api/roles';
import type { Member } from '$lib/api/types';
import { memberRoles } from '$lib/stores/memberRoles.svelte';
import { userCache } from '$lib/stores/users.svelte';

export class Traegerliste {
  mitglieder = $state<Member[]>([]);
  /** user_id → Rollen-IDs (ohne @everyone, das ist implizit). */
  rollen = $state<Record<string, string[]>>({});
  geladen = $state(false);
  laedt = $state(false);

  async laden(guildId: string): Promise<void> {
    if (this.laedt) return;
    this.laedt = true;
    try {
      const [mitglieder, bulk] = await Promise.all([
        chatApi.listMembers(guildId),
        rolesApi.bulkMemberRoles(guildId)
      ]);
      this.mitglieder = mitglieder;
      const naechste: Record<string, string[]> = {};
      for (const mbr of mitglieder) {
        naechste[mbr.user_id] = bulk[mbr.user_id] ?? [];
        // Namen nachziehen, sonst stehen in den Chips rohe Snowflakes.
        userCache.queue(mbr.user_id);
      }
      this.rollen = naechste;
      // Der Rest der Anwendung faerbt und gruppiert Mitglieder ueber
      // denselben Cache — wenn wir die Angabe ohnehin haben, gehoert sie
      // dorthin, statt sie gleich darauf noch einmal zu holen.
      memberRoles.seedAll(guildId, bulk, mitglieder.map((mbr) => mbr.user_id));
      this.geladen = true;
    } catch {
      // Absichtlich still: die Rollenverwaltung funktioniert ohne die
      // Zahlen weiter, nur eben ohne Zahlen. Ein Fehler-Toast beim
      // Oeffnen des Reiters waere Laerm ohne Handlungsmoeglichkeit.
      this.geladen = false;
    } finally {
      this.laedt = false;
    }
  }

  /** Anzahl der Traeger, oder `null`, solange nichts Verlaessliches
   * vorliegt. `@everyone` traegt jeder — das ist keine Zuweisung,
   * sondern der Boden, deshalb die Mitgliederzahl der Community. */
  anzahl(roleId: string, istEveryone = false): number | null {
    if (!this.geladen) return null;
    if (istEveryone) return this.mitglieder.length;
    let n = 0;
    for (const ids of Object.values(this.rollen)) {
      if (ids.includes(roleId)) n++;
    }
    return n;
  }

  /** user_ids der Traeger, in Mitgliederlisten-Reihenfolge. */
  traeger(roleId: string): string[] {
    return this.mitglieder
      .filter((mbr) => (this.rollen[mbr.user_id] ?? []).includes(roleId))
      .map((mbr) => mbr.user_id);
  }

  /** Mitglieder OHNE diese Rolle — die Auswahl des Hinzufuegen-Feldes. */
  ohneRolle(roleId: string): Member[] {
    return this.mitglieder.filter((mbr) => !(this.rollen[mbr.user_id] ?? []).includes(roleId));
  }

  /** Zuweisen oder entziehen. Erst oertlich umgelegt (kein Flackern),
   * bei Serverfehler zurueckgedreht — und zwar gegen den AKTUELLEN Stand,
   * nicht gegen einen Schnappschuss von vorher: waehrend der Anfrage kann
   * eine ANDERE Zuweisung desselben Mitglieds gelandet sein, die ein
   * Schnappschuss-Rollback wieder verwuerfe. */
  async setzen(guildId: string, roleId: string, userId: string, an: boolean): Promise<void> {
    this._umlegen(userId, roleId, an);
    try {
      if (an) await rolesApi.assign(guildId, userId, roleId);
      else await rolesApi.unassign(guildId, userId, roleId);
      memberRoles.invalidate(guildId, userId);
    } catch (err) {
      this._umlegen(userId, roleId, !an);
      throw err;
    }
  }

  private _umlegen(userId: string, roleId: string, an: boolean): void {
    const bisher = this.rollen[userId] ?? [];
    const hat = bisher.includes(roleId);
    if (hat === an) return;
    this.rollen = {
      ...this.rollen,
      [userId]: an ? [...bisher, roleId] : bisher.filter((id) => id !== roleId)
    };
  }

  /** Nach dem Loeschen einer Rolle: die Zuordnung ist beim Server weg,
   * ohne das haengen die Zaehler bis zum naechsten Oeffnen hinterher. */
  rolleVergessen(roleId: string): void {
    const naechste: Record<string, string[]> = {};
    for (const [uid, ids] of Object.entries(this.rollen)) {
      naechste[uid] = ids.filter((id) => id !== roleId);
    }
    this.rollen = naechste;
  }
}

/** Passt ein Mitglied zur Suche? `nadel` kommt schon klein geschrieben und
 * beschnitten herein, damit der Aufrufer sie nicht je Zeile neu herrichtet.
 *
 * Steht neben der Traegerliste, weil BEIDE Mitgliedersuchen dieselbe Frage
 * stellen — die rollenzentrierte (`RolleTraeger`) und die
 * mitgliederzentrierte (`MemberRoleAssignment`). Die rohe user_id gehoert
 * mit dazu: Administratoren bekommen Snowflakes aus Logs und Berichten
 * gereicht, nicht Namen. */
export function passtZurSuche(mbr: Member, nadel: string): boolean {
  return (
    (mbr.nickname ?? '').toLowerCase().includes(nadel) ||
    userCache.displayName(mbr.user_id).toLowerCase().includes(nadel) ||
    mbr.user_id.includes(nadel)
  );
}
