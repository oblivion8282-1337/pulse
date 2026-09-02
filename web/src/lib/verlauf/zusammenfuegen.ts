import { vergleicheSnowflakeArtigeId } from '../utils/snowflakeZeit.ts';

/**
 * Fuehrt den lokalen Bestand eines DM-Kanals mit der Serverantwort zusammen
 * — importiert bewusst NUR `../utils/snowflakeZeit.ts` (importfrei bis auf
 * diese eine Datei, die selbst importfrei ist und per erweiterungspflichtigem
 * Relativpfad eingebunden wird), damit Nodes Testlaeufer die einzige echte
 * Rechnung dieser Etappe direkt prueft (s. CLAUDE.md „Die Falle").
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
 * ID-Vergleich fuer den Merge — die eigentliche Rechnung (eingebettete Zeit
 * aus beiden ID-Schemata entschluesseln und DIE vergleichen, statt roh nach
 * Laenge/lexikografisch) steht in `../utils/snowflakeZeit.ts` (dort
 * ausfuehrlich begruendet, inkl. warum "auf gemeinsame Breite auffuellen,
 * dann lexikografisch" ebenfalls NICHT reicht). Frueher hier dupliziert,
 * weil dieses Modul ueber `$lib/utils/snowflake` importfrei bleiben musste —
 * ein erweiterungspflichtiger Relativpfad (`../utils/snowflakeZeit.ts`)
 * loest das, ohne die Node-Testlaeufer-Falle (s. CLAUDE.md) zu beruehren.
 */
const vergleicheId = vergleicheSnowflakeArtigeId;

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
