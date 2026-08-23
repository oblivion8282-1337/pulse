/**
 * Die Zeitangabe rechts in einer Gespraechs-Zeile.
 *
 * Bewusst nicht `formatRelative`: „vor 3 Stunden" ist in einer Liste die
 * falsche Auskunft. Wer eine Gespraechsliste ueberfliegt, sucht die Stelle, an
 * der der gestrige Tag anfaengt — dafuer braucht es eine Uhrzeit fuer heute,
 * ein Wort fuer gestern und ein Datum fuer alles Aeltere. Genau so machen es
 * die Messenger, an denen sich der Entwurf orientiert.
 *
 * **Importfrei**, damit Nodes Testlaeufer die Datei pruefen kann.
 */

/**
 * @param iso Zeitstempel der letzten Nachricht.
 * @param jetzt Vergleichszeitpunkt — nur fuer Tests; sonst die aktuelle Zeit.
 * @param locale Sprachkennung; bestimmt Zahlenformat und Wochentagsnamen.
 */
export function kurzeUhrzeit(
  iso: string | null | undefined,
  jetzt: Date = new Date(),
  locale?: string
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const tage = tagesAbstand(d, jetzt);
  if (tage === 0) {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (tage < 7) {
    // Gestern und die Tage davor teilen sich eine Antwort: den Wochentagsnamen.
    //
    // Fuer „gestern" gibt es bewusst KEINEN eigenen Katalog-Schluessel — die
    // Sprachdatei kennt das Wort nicht, und ein Wochentagsname ist hier
    // genauso brauchbar und kommt ohne neue Uebersetzung aus. Damit fallen
    // beide Faelle zusammen, statt zweimal dasselbe zurueckzugeben.
    return d.toLocaleDateString(locale, { weekday: 'short' });
  }
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
}

/**
 * Abstand in KALENDERTAGEN, nicht in 24-Stunden-Schritten.
 *
 * Eine Nachricht von gestern 23:50 ist um 00:10 zehn Minuten alt und trotzdem
 * von gestern — mit einer Stundenrechnung stuende dort die Uhrzeit, als waere
 * sie von heute.
 */
function tagesAbstand(a: Date, b: Date): number {
  const tagA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const tagB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((tagB - tagA) / 86_400_000);
}
