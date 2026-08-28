/**
 * Fuehrt den lokalen Bestand eines DM-Kanals mit der Serverantwort zusammen
 * — importfrei, damit Nodes Testlaeufer die einzige echte Rechnung dieser
 * Etappe direkt prueft (s. CLAUDE.md „Die Falle").
 *
 * Vier Faelle (Plan Task 2, Schritt 1): Duplikate erscheinen einmal, der
 * Server gewinnt bei bearbeiteten Nachrichten, ein lokaler Grabstein
 * ueberlebt eine Server-Antwort ohne ihn, und die Reihenfolge folgt den
 * Nachrichten-IDs.
 *
 * "Ohne ihn" ist dabei der REGELFALL, kein Rand: der Server liefert
 * geloeschte Nachrichten grundsaetzlich nicht mehr aus (`Message.deleted_at
 * .is_(None)`-Filter in `routes/messages.py`) — "fehlt in der Server-Antwort"
 * beweist also nichts ueber die Nachricht, nur, dass der Server sie (aus
 * welchem Grund auch immer) gerade nicht ausliefert.
 */

/** Was die Merge-Rechnung von einem Posten braucht — der Rest (Inhalt,
 *  Anhaenge, …) reist als beliebige Nutzlast im generischen Typ `T` mit. */
export type Mergeposten = {
  id: string;
  bearbeitetAm: string | null;
  geloescht: boolean;
};

/**
 * Snowflake-Vergleich, dupliziert aus `utils/snowflake.ts::compareSnowflakeId`
 * — dieses Modul darf nichts importieren (importfrei-Pflicht). Laenge
 * zuerst: Snowflakes wachsen ueber die Zeit in der Stellenzahl, ein reiner
 * Stringvergleich ordnete "9" faelschlich hinter "10".
 */
function vergleicheId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `lokal` ist die erste Quelle, `vomServer` ergaenzt/ueberschreibt sie —
 * AUSSER ein lokaler Posten ist ein Grabstein: dann bleibt er einer, egal
 * was (oder ob ueberhaupt etwas) der Server zu derselben ID sagt.
 */
export function zusammenfuegen<T extends Mergeposten>(lokal: T[], vomServer: T[]): T[] {
  const byId = new Map<string, T>();
  for (const posten of lokal) byId.set(posten.id, posten);
  for (const posten of vomServer) {
    const bestehend = byId.get(posten.id);
    if (bestehend?.geloescht) continue; // Grabstein ueberlebt
    byId.set(posten.id, posten);
  }
  return [...byId.values()].sort((a, b) => vergleicheId(a.id, b.id));
}
