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
 * Ungelesene private Gespräche — die **Anzahl der Gespräche**, nicht die der
 * Nachrichten. An einer Leiste interessiert „wie viele warten auf mich", nicht
 * „wie viel Text ist aufgelaufen"; eine Zahl im dreistelligen Bereich sagt
 * einem Nutzer nichts mehr.
 */
export function ungeleseneChats(): number {
  return directMessages.list.filter((dm) => readState.isUnread(dm.id)).length;
}

/** Eingehende Freundschaftsanfragen — dieselbe Quelle wie die Liste im Bereich. */
export function offeneAnfragen(): number {
  return friendRequests.incomingList.length;
}
