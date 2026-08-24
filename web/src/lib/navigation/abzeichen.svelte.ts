/**
 * Die Zahlen an der Bereichs-Leiste.
 *
 * **Warum eigenes Modul:** Handy-Leiste und Tablet-Spalte zeigen dieselben
 * beiden Zahlen. Stünde die Rechnung in beiden Komponenten, liefe sie
 * irgendwann auseinander — und zwar unbemerkt, weil man nie beide Größen
 * gleichzeitig vor sich hat.
 *
 * Bewusst NICHT in `tabs.ts`: das Modul dort ist importfrei, damit Nodes
 * Testläufer es prüfen kann. Hier hängen Stores dran, also gehört es
 * getrennt.
 */
import { directMessages } from '$lib/stores/directMessages.svelte';
import { friendRequests } from '$lib/stores/friendRequests.svelte';
import { readState } from '$lib/stores/readState.svelte';

/**
 * Ungelesene private Nachrichten — die **zusammengezählte Anzahl** über alle
 * Gespräche, nicht die Anzahl der Gespräche (Umstellung 2026-08-24 auf
 * Nutzerwunsch): zwei neue Nachrichten im selben Chat sind eine 2, nicht eine
 * 1. Gekappt wird erst in der Anzeige (99+), nicht hier.
 */
export function ungeleseneChats(): number {
  return directMessages.list.reduce(
    (sum, dm) => sum + readState.getUnreadCount(dm.id),
    0
  );
}

/** Eingehende Freundschaftsanfragen — dieselbe Quelle wie die Liste im Bereich. */
export function offeneAnfragen(): number {
  return friendRequests.incomingList.length;
}
