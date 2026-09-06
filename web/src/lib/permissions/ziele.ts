/**
 * Die Ziele der linken Spalte — Rollen und einzelne Mitglieder.
 *
 * **Zwei Gruppen statt eines Hinzufügen-Feldes.** Früher standen links nur die
 * Ziele mit Abweichung, alles Übrige lag in zwei Auswahlfeldern darüber. Wer
 * wissen wollte, ob eine Rolle im Kanal eine Sonderregel hat, musste beide
 * Listen im Kopf zusammenführen. Jetzt steht alles in einer Liste, getrennt in
 * „Mit Abweichung" und „Ohne Abweichung" — und eine Abweichung entsteht
 * dadurch, dass man ein Ziel auswählt und etwas setzt.
 *
 * **Eckig gegen rund:** Rollen tragen einen Farbpunkt, Mitglieder ein rundes
 * Bild — dieselbe Unterscheidung wie im Rest der Oberfläche.
 */

import type { Role } from '$lib/api/roles';
import type { Member } from '$lib/api/types';
import { safeAvatarUrl } from '$lib/avatar';
import { userCache } from '$lib/stores/users.svelte';
import { vergleichRollen } from './bitfield';

export type ZielEintrag = {
  /** `<art>:<id>` — derselbe Schlüssel wie bei den Überschreibungen. */
  key: string;
  art: 0 | 1;
  id: string;
  name: string;
  /** Nur Rollen: `#rrggbb` oder `null`. */
  farbe: string | null;
  /** Nur Mitglieder: geprüfte Bild-Adresse oder `null`. */
  avatar: string | null;
  initialen: string;
  istEveryone: boolean;
  /** Wie viele Rechte beim Ziel auf Erlauben oder Verbieten stehen — `0` heisst
   *  „keine Abweichung", gespeichert wie im Entwurf. */
  gesetzte: number;
};

export function baueZiele(
  rollen: readonly Role[],
  mitglieder: readonly Member[],
  gesetzte: (key: string) => number
): ZielEintrag[] {
  const rollenZiele = [...rollen]
    // Absteigend (wichtigste zuerst), aber derselbe Rollen-Vergleich wie
    // überall sonst.
    .sort((a, b) => vergleichRollen(b, a))
    .map((r) => ({
      key: `0:${r.id}`,
      art: 0 as const,
      id: r.id,
      name: r.name,
      farbe: r.color != null ? '#' + r.color.toString(16).padStart(6, '0') : null,
      avatar: null,
      initialen: r.name.slice(0, 1).toUpperCase(),
      istEveryone: r.is_everyone,
      gesetzte: gesetzte(`0:${r.id}`)
    }));

  const mitgliedZiele = mitglieder
    .map((mem) => {
      const name = mem.nickname ?? userCache.displayName(mem.user_id);
      return {
        key: `1:${mem.user_id}`,
        art: 1 as const,
        id: mem.user_id,
        name,
        farbe: null,
        avatar: safeAvatarUrl(userCache.get(mem.user_id)?.avatar_url),
        initialen: name.slice(0, 1).toUpperCase(),
        istEveryone: false,
        gesetzte: gesetzte(`1:${mem.user_id}`)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...rollenZiele, ...mitgliedZiele];
}
