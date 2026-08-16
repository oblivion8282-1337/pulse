/**
 * Wann sich das Player-Fenster des Steuernden öffnet.
 *
 * ## Bei der Zusage, nicht beim Klick
 *
 * Bis 2026-08-16 lief es andersherum: der Anfrage-Knopf sass in der Kachel des
 * bereits laufenden Player-Fensters, das Fenster musste also VOR der Anfrage
 * offen sein. Das war technisch begründet — erfasst wird im Fenster —, als
 * Bedienung aber verkehrt herum: wer steuern will, öffnet erst ein Fenster,
 * wechselt zurück in die App und klickt dort.
 *
 * Jetzt fragt man beim Zusehen an, und das Fenster ist die **Folge der
 * Zusage**. Der Unterschied ist nicht nur ein gesparter Klick:
 *
 * * Eine **abgelehnte oder abgelaufene** Anfrage hinterlässt nichts. Vorher
 *   stand man mit einem offenen Fenster da, das man selbst wieder zumachen
 *   musste — und in dem nichts anders aussah als vorher.
 * * Das Fenster erscheint **genau dann, wenn es etwas kann**. Ein Fenster, das
 *   während des Wartens schon offensteht, sieht aus wie eine laufende
 *   Fernsteuerung, ist aber nur ein Bild.
 *
 * ## Warum ein eigenes Modul für drei Zeilen
 *
 * Der Ruf sitzt in `session.svelte.ts` an der Stelle, an der die Sitzung nach
 * `active` springt. Diese Datei liegt bereits über der Größen-Grenze
 * (PLAN.md §12.1); alles, was dort nicht zwingend stehen muss, steht daneben.
 * Ausserdem gehört das Wissen „wie öffnet man ein Player-Fenster" nicht in die
 * Sitzungsverwaltung — sie kennt Rollen und Phasen, nicht Fenster.
 */

import { nativeWindowRequests } from '$lib/player/wuensche.svelte';

/**
 * Das Player-Fenster für die zugesagte Sitzung anfordern.
 *
 * Nur für den **Steuernden**: beim Host läuft das Bild ohnehin auf seinem
 * eigenen Schirm, und ein Fenster, das sich bei ihm öffnet, wäre eine zweite
 * Ansicht dessen, was er vor sich hat.
 *
 * Mehrfach zu rufen ist harmlos — die Wünsche sind eine Menge, kein Zähler.
 * Das gilt insbesondere für den Weg über ein Standplatz-Gerät: dort ist das
 * Fenster schon vor der Zusage angefordert (`devices/schirme.svelte.ts`), weil
 * die Zusage dort selbsttätig kommt.
 */
export function fensterZurSitzung(
  rolle: 'controller' | 'host' | null,
  channelId: string | null,
  hostUserId: string | null,
  slot: number,
): void {
  if (rolle !== 'controller' || !channelId || !hostUserId) return;
  nativeWindowRequests.request(channelId, hostUserId, slot);
}
