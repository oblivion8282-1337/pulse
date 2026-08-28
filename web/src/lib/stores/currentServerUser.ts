import { auth } from './auth.svelte';

/**
 * Die eigene Nutzer-Kennung.
 *
 * **Diese Funktion ist seit dem 2026-08-28 trivial**, und das ist der Punkt.
 *
 * Vorher gab die Cloud dir eine Kennung und jeder Self-Host eine andere (ein
 * Pseudonym je Server). Jede Prüfung „gehört das mir?" gegen eine
 * server-lokale Kennung — die `author_id` einer Nachricht, die `owner_id` einer
 * Community, ein `user_id` in einem WS-Ereignis — musste deshalb gegen DIESE
 * Kennung vergleichen und niemals gegen `auth.user.id`; sonst konnte man auf
 * einem Self-Host seine eigenen Nachrichten nicht bearbeiten, Besitzer-Optionen
 * verschwanden, und „melden" erschien auf der eigenen Nachricht. Der Umbau, der
 * das reparierte, ging durch 28 Dateien.
 *
 * Mit dem Ticket-Weg gibt es nur noch eine Kennung: Der Self-Host führt
 * dieselbe Zahl wie die Cloud. Die Funktion bleibt vorerst stehen, damit die
 * rund 40 Aufrufstellen unverändert bleiben — sie sind ab jetzt nur noch ein
 * längerer Weg zu `auth.user?.id`. Wer sie auflöst, tut es als eigene,
 * mechanische Änderung; hier zusammen mit dem Umbau wäre es ein Diff, in dem
 * niemand mehr das Wesentliche fände.
 */
export function currentServerUserId(): string | null {
  return auth.user?.id ?? null;
}

/**
 * Früher: die eigene Kennung auf dem *sendenden* Server — nötig, weil ein
 * Ereignis von der Cloud-Hintergrundverbindung eine andere Kennung betraf als
 * eine vom aktiven Self-Host.
 *
 * Auch das ist mit der einen Kennung gegenstandslos. Der Name bleibt, solange
 * die Aufrufstellen ihn benutzen.
 */
export function dispatchingUserId(): string | null {
  return auth.user?.id ?? null;
}
