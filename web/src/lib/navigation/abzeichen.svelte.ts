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
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { readState } from '$lib/stores/readState.svelte';

/** Ungelesene Nachrichten eines Gesprächs, mit demselben Rückfall wie
 *  `ungeleseneChats` (s. dessen Begründung: der Zähler kennt nur, was diese
 *  Sitzung erlebt hat — wo er schweigt, die Liste aber „ungelesen" sagt,
 *  zählt das Gespräch mindestens einfach). */
function zahlEinesGespraechs(kanalId: string): number {
  const zahl = readState.getUnreadCount(kanalId);
  if (zahl > 0) return zahl;
  return readState.isUnread(kanalId) ? 1 : 0;
}

/**
 * Ungelesene private Nachrichten — die **zusammengezählte Anzahl** über alle
 * Gespräche, nicht die Anzahl der Gespräche (Umstellung 2026-08-24 auf
 * Nutzerwunsch): zwei neue Nachrichten im selben Chat sind eine 2, nicht eine
 * 1. Gekappt wird erst in der Anzeige (99+), nicht hier.
 *
 * **Der Zähler allein genügt nicht.** `unreadCountByChannel` wird nur von
 * lebenden WS-Ereignissen hochgezählt (plus dem, was im Speicher des Geräts
 * lag) — er wird nie aus dem `ready`-Rahmen befüllt, anders als die Karten,
 * auf denen `isUnread()` rechnet. Auf einem frisch angemeldeten Gerät, nach
 * gelöschten Website-Daten oder für Nachrichten, die bei geschlossener App
 * kamen, stünde das Abzeichen deshalb auf 0, während die Liste darunter
 * ungelesene Zeilen zeigt. Wo der Zähler nichts weiss, die Liste aber
 * „ungelesen" sagt, zählt das Gespräch mindestens einfach.
 *
 * Aus demselben Grund NICHT über `readState.sumUnread(ids)`: der summiert nur
 * den Zähler und hätte genau diese Lücke.
 */
export function ungeleseneChats(): number {
  return directMessages.list.reduce((summe, dm) => summe + zahlEinesGespraechs(dm.id), 0);
}

/**
 * Die Zahl für das App-Icon (iOS) — ungelesene Nachrichten über alle
 * privaten Gespräche: Direktnachrichten UND private Gruppen.
 *
 * **Warum Community-Kanäle NICHT mitzählen**, obwohl der Titel-Punkt sie
 * berücksichtigt: Die Zahl am Icon muss dasselbe zählen, was der Server im
 * Push fortschreibt, sonst springt sie bei jeder Korrektur. Und der Server
 * schreibt nur fort, was er auch hinausschickt — FCM-Pushes gehen heute für
 * DMs und private Gruppen raus, nicht für Community-Nachrichten
 * (`push.py`: `fan_out_dm_push` und `fan_out_dm_push_encrypted` sind die
 * beiden Aufrufer von `fan_out_fcm_dm_push`). Wer das ändert, zieht BEIDE
 * Seiten nach — sonst zeigt das Icon zwei verschiedene Wahrheiten,
 * abhängig davon, ob die App gerade wach war.
 */
export function ungeleseneNachrichten(): number {
  const gruppen = privateGruppen.list.reduce(
    (summe, g) => summe + zahlEinesGespraechs(g.id),
    0
  );
  return ungeleseneChats() + gruppen;
}

/** Eingehende Freundschaftsanfragen — dieselbe Quelle wie die Liste im Bereich. */
export function offeneAnfragen(): number {
  return friendRequests.incomingList.length;
}
