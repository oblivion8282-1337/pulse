/**
 * Reine Rechnung fuer den Hintergrund-Abgleich einer bereits ausgelieferten
 * lokalen Seite gegen den Server (`nachladen.ts::reconciliereAeltereSeite`,
 * Bughunt Fund 3) — importfrei, damit Nodes Testlaeufer sie direkt prueft
 * (s. CLAUDE.md „Die Falle").
 */

/** Ermittelt, welche lokal gehaltenen IDs in der Serverantwort NICHT mehr
 *  auftauchen. Der Server liefert geloeschte Nachrichten grundsaetzlich
 *  nicht aus (`Message.deleted_at.is_(None)`-Filter, s.
 *  `zusammenfuegen.ts`-Kommentar) — "fehlt in der Antwort" ist hier also der
 *  REGELFALL fuer eine zwischenzeitliche Loeschung, kein Sonderfall. Anders
 *  als beim Merge in `zusammenfuegen.ts` gibt es hier keinen lokalen
 *  Grabstein-Vorrang zu beachten: die Spanne war bereits lokal bekannt, ein
 *  Fehlen kann also nicht "Historie-Ende" bedeuten. */
export function ermittleGeloeschteIds(
  lokal: { id: string; verschluesselt?: boolean }[],
  vomServer: { id: string }[]
): string[] {
  const nochVorhanden = new Set(vomServer.map((m) => m.id));
  // **Verschluesselte Nachrichten NIE ueber den Server abgleichen.** Der
  // Server hat sie nie gesehen — fuer sie ist „fehlt in der Antwort" der
  // Normalzustand, nicht eine Loeschung. Bis zum 2026-09-03 stand das hier
  // nicht, und auf einem Geraet mit lokalem Verlauf (Flatpak-App, Archiv
  // angeschlossen) markierte ein einziges Hochscrollen JEDE verschluesselte
  // Nachricht der Seite als geloescht — nachgezaehlt: 25 von 29, davon 19
  // eigene — und schrieb dazu Grabsteine ins Archiv, die der naechste Start
  // wieder anwandte. Sichtbar wurde es als „alle Nachrichten von dev sind
  // nach einem Neuladen weg". Der Browser des anderen Nutzers sah es nicht:
  // ein frisches Geraet hat keine lokale Seite, also nichts abzugleichen.
  return lokal
    .filter((n) => n.verschluesselt !== true && !nochVorhanden.has(n.id))
    .map((n) => n.id);
}
