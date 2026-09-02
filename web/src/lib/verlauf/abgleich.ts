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
  lokal: { id: string }[],
  vomServer: { id: string }[]
): string[] {
  const nochVorhanden = new Set(vomServer.map((m) => m.id));
  return lokal.filter((n) => !nochVorhanden.has(n.id)).map((n) => n.id);
}
