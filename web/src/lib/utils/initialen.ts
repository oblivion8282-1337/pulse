/**
 * Initialen als Ersatz fuer ein fehlendes Bild.
 *
 * Stand nach dem Mobil-Umbau wortgleich an drei Stellen (Raeume-Kacheln,
 * Entdecken-Karten, Profilblock im Du-Bereich) — dieselben zwei Buchstaben
 * unter demselben Farbverlauf. Eine gemeinsame Fassung, weil ein spaeterer
 * Feinschliff sonst nur an einer der drei ankaeme und die anderen unbemerkt
 * anders aussaehen.
 *
 * **Bewusst NICHT auch fuer `GuildRail.svelte`.** Deren Fassung schneidet
 * VOR dem Abbilden auf den ersten Buchstaben zu und filtert keine leeren
 * Stuecke — bei einem Namen mit fuehrendem Leerzeichen liefert sie etwas
 * anderes als diese hier. Das anzugleichen waere eine Verhaltensaenderung
 * und gehoert nicht in eine Aufraeumrunde.
 *
 * **Importfrei**, damit Nodes Testlaeufer die Datei pruefen kann.
 */

/** Die ersten Buchstaben der ersten beiden Woerter, gross. */
export function initialen(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
