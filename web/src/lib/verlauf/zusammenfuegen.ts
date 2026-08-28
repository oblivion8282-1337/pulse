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
 * ID-Vergleich fuer den Merge — bewusst NICHT `compareSnowflakeId` aus
 * `utils/snowflake.ts` (dieses Modul darf nichts importieren, importfrei-
 * Pflicht) und bewusst NICHT nur "auf gemeinsame Breite auffuellen, dann
 * lexikografisch vergleichen": fuer Ziffernfolgen OHNE fuehrende Null ist
 * das mathematisch IDENTISCH mit "Laenge zuerst, dann lexikografisch" — ein
 * laengerer String stellt immer die groessere Zahl dar, Nullen davor aendern
 * daran nichts. Beide Ansaetze liefern deshalb fuer JEDES Paar aus einer
 * echten Snowflake und einer `krypto/senden.ts::lokaleNachrichtId()`-ID
 * dasselbe (falsche) Ergebnis: eine lokale ID ist IMMER 20 Ziffern (13
 * `Date.now()` + 7 Zufallsstellen, GESCHAETZTER Wert ~1,8·10^19), eine echte
 * Snowflake heute 17 Ziffern (~10^17) und selbst am Ende ihres 42-Bit-
 * Zeitfelds in ~139 Jahren hoechstens ~1,84·10^19 — die lokale ID waechst mit
 * `Date.now()` aber schneller (Faktor 10^7 pro ms ggu. 2^22 ≈ 4,19·10^6 pro
 * ms bei der Snowflake) und bleibt darum numerisch fuer die gesamte
 * praktische Lebensdauer beider Schemata groesser, UNABHAENGIG vom
 * tatsaechlichen Erstellzeitpunkt. Ein reiner Zahlenvergleich der ROH-IDs
 * (mit `padStart` oder `BigInt`, egal welcher Technik) kann das Problem aus
 * dem Bughunt (verschluesselte Nachrichten sortieren dauerhaft hinter
 * unverschluesselten) deshalb NICHT loesen — das ist keine Vermutung,
 * sondern an den beiden Beispielwerten aus dem Bughunt nachgerechnet
 * (86840432528457728 vs. 17879299725321234567: 17 Stellen < 20 Stellen bei
 * BEIDEN Verfahren, siehe `verlauf-zusammenfuegen.test.ts`).
 *
 * Der einzige gemeinsame Nenner beider Schemata ist die eingebettete
 * Unix-Millisekunde — die entschluesseln wir stattdessen und vergleichen
 * DIE:
 * - `lokaleNachrichtId()`: die ersten 13 Ziffern SIND `Date.now()`.
 * - echte Snowflake (`dcc_shared/snowflake.py`): oberste 42 Bit sind
 *   ms seit `DEFAULT_EPOCH_MS` (2026-01-01T00:00:00Z), gefolgt von 10 Bit
 *   Worker- und 12 Bit Sequenz-ID — Rausschieben der unteren 22 Bit
 *   (WORKER_BITS + SEQ_BITS) liefert das Zeitfeld.
 * Beide 64-Bit-Werte sprengen den sicheren `Number`-Bereich (2^53) —
 * deshalb `BigInt`, kein Import noetig (globales JS/TS-Sprachfeature).
 * Bei gleicher Millisekunde (zwei echte Snowflakes derselben Sekunde,
 * oder ein Duplikat) entscheidet als Tiebreak weiterhin die rohe Zahl.
 */
const SNOWFLAKE_EPOCH_MS = 1767225600000n; // dcc_shared/snowflake.py::DEFAULT_EPOCH_MS
const SNOWFLAKE_ZEIT_SHIFT = 22n; // WORKER_BITS(10) + SEQ_BITS(12)
const LOKALE_ID_LAENGE = 20; // lokaleNachrichtId(): 13-stelliger Date.now() + 7 Zufallsstellen
const LOKALE_ID_ZEIT_STELLEN = 13;

function echtZeitMs(id: string): bigint {
  if (id.length === LOKALE_ID_LAENGE) {
    return BigInt(id.slice(0, LOKALE_ID_ZEIT_STELLEN));
  }
  return (BigInt(id) >> SNOWFLAKE_ZEIT_SHIFT) + SNOWFLAKE_EPOCH_MS;
}

function vergleicheId(a: string, b: string): number {
  const za = echtZeitMs(a);
  const zb = echtZeitMs(b);
  if (za !== zb) return za < zb ? -1 : 1;
  const na = BigInt(a);
  const nb = BigInt(b);
  return na < nb ? -1 : na > nb ? 1 : 0;
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
