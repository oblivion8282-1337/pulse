/**
 * Gemeinsame Rechnung fuer den Vergleich zweier Snowflake-artiger IDs, wenn
 * DREI verschiedene ID-Schemata gemischt auftreten koennen: echte
 * Server-Snowflakes (`dcc_shared/snowflake.py`), lokal vergebene Kennungen
 * aus `krypto/senden.ts::lokaleNachrichtId()` UND die vorlaeufige `tmp-`-ID
 * einer noch nicht bestaetigten Nachricht (`chat/dmKlartextSenden.ts`).
 *
 * Das dritte kam nicht als Erweiterung dazu, sondern war von Anfang an da
 * und wurde uebersehen: bis zum 2026-08-31 sprach dieser Kopf von zweien,
 * und `BigInt(id)` warf auf der `tmp-`-Form mitten im `Array.sort` — mit dem
 * unbehandelten Fehler riss die Listendarstellung ab, sichtbar im
 * Playwright-Lauf sowohl aus der Community-Kanal- als auch aus der DM-Route.
 * Deshalb faellt der Vergleich unten fuer ein UNBEKANNTES Schema nicht mehr
 * durch, sondern ordnet es deterministisch nach hinten.
 *
 * Ein reiner Groessenvergleich der rohen IDs — ob "Laenge zuerst" oder "auf
 * gemeinsame Breite auffuellen, dann lexikografisch" — ist fuer Ziffernfolgen
 * OHNE fuehrende Null mathematisch IDENTISCH: ein laengerer String stellt
 * immer die groessere Zahl dar. Eine lokale ID ist IMMER 20 Ziffern (13
 * `Date.now()` + 7 Zufallsstellen, ~1,8·10^19), eine echte Snowflake heute
 * 17 Ziffern (~10^17) und selbst am Ende ihres 42-Bit-Zeitfelds in ~139
 * Jahren hoechstens ~1,84·10^19 — die lokale ID waechst mit `Date.now()`
 * aber schneller (Faktor 10^7 pro ms ggu. 2^22 ≈ 4,19·10^6 pro ms bei der
 * Snowflake) und bleibt darum numerisch fuer die gesamte praktische
 * Lebensdauer beider Schemata groesser, UNABHAENGIG vom tatsaechlichen
 * Erstellzeitpunkt. Belegt an einem nachgerechneten Beispielpaar aus dem
 * Bughunt: verschluesselte Nachrichten sortierten dauerhaft hinter
 * unverschluesselten (siehe `web/test/snowflake-vergleich.test.ts` und
 * `web/test/verlauf-zusammenfuegen.test.ts`).
 *
 * Der einzige gemeinsame Nenner beider Schemata ist die eingebettete
 * Unix-Millisekunde — wir entschluesseln stattdessen die und vergleichen
 * DIE:
 * - `lokaleNachrichtId()`: die ersten 13 Ziffern SIND `Date.now()`.
 * - echte Snowflake: oberste 42 Bit sind ms seit `DEFAULT_EPOCH_MS`
 *   (2026-01-01T00:00:00Z), gefolgt von 10 Bit Worker- und 12 Bit
 *   Sequenz-ID — Rausschieben der unteren 22 Bit (WORKER_BITS + SEQ_BITS)
 *   liefert das Zeitfeld.
 * Beide 64-Bit-Werte sprengen den sicheren `Number`-Bereich (2^53) —
 * deshalb `BigInt`, kein Import noetig (globales JS/TS-Sprachfeature).
 * Bei gleicher Millisekunde (zwei echte Snowflakes derselben Sekunde, oder
 * ein Duplikat) entscheidet als Tiebreak die rohe Zahl.
 *
 * Importfrei (s. CLAUDE.md „Die Falle" zu `pnpm test:unit`), damit Nodes
 * eingebauter Testlaeufer diese Datei direkt prueft, und damit sie ihrerseits
 * gefahrlos per erweiterungspflichtigem Relativpfad (`./snowflakeZeit.ts`,
 * `../utils/snowflakeZeit.ts`) importiert werden kann, ohne dass Node beim
 * Aufloesen scheitert.
 */

const SNOWFLAKE_EPOCH_MS = 1767225600000n; // dcc_shared/snowflake.py::DEFAULT_EPOCH_MS
const SNOWFLAKE_ZEIT_SHIFT = 22n; // WORKER_BITS(10) + SEQ_BITS(12)
const LOKALE_ID_LAENGE = 20; // lokaleNachrichtId(): 13-stelliger Date.now() + 7 Zufallsstellen
const LOKALE_ID_ZEIT_STELLEN = 13;
/** `chat/dmKlartextSenden.ts`: `tmp-${nonce}` mit `nonce = n-${Date.now()}-${4
 *  Hexstellen}` — die optimistische Kopie einer noch nicht bestaetigten
 *  Nachricht. Das dritte Schema; der Modulkopf sprach frueher von zweien. */
const VORLAEUFIG_PRAEFIX = 'tmp-n-';

function istVorlaeufig(id: string): boolean {
  return id.startsWith(VORLAEUFIG_PRAEFIX);
}

function istZiffernfolge(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** Entschluesselt die eingebettete Unix-Millisekunde aus einer ID beliebigen
 *  der beiden Schemata.
 *
 *  **Woran die beiden auseinandergehalten werden — und wie lange das traegt.**
 *  Unterschieden wird an der Stellenzahl, also an genau der Groesse, deren
 *  naiver Gebrauch der Grund fuer diese Datei war. Das ist hier zulaessig,
 *  aber nicht zeitlos, und die Grenze ist ausgerechnet: eine echte Snowflake
 *  erreicht 20 Stellen, sobald ihr Wert 10^19 ueberschreitet, also bei einem
 *  Zeitfeld von 10^19 / 2^22 ≈ 2,384·10^12 ms — rund 75,6 Jahre nach der
 *  Epoche, mithin etwa 2101. Ab dann faende dieser Zweig in einer echten
 *  Snowflake ihre ersten 13 Ziffern und deutete sie als `Date.now()`, was
 *  eine sinnlose Zeit ergibt. Das ist KEINE Aussage ueber die Erschoepfung
 *  des 42-Bit-Zeitfelds (die kommt erst ~2165) — es sind zwei verschiedene
 *  Zeitpunkte, und der fruehere ist der, der hier zaehlt.
 *
 *  Wer die Schemata dauerhaft trennen will, macht die lokale Kennung
 *  selbstkennzeichnend (etwa ein Praefix) statt sie an ihrer Laenge zu
 *  erraten; das beruehrt dann aber bereits abgelegten Verlauf und ist
 *  deshalb bewusst nicht Teil dieser Fehlerbehebung. */
export function echtZeitMs(id: string): bigint {
  const ms = zeitOderNull(id);
  if (ms === null) throw new SyntaxError(`unbekanntes ID-Schema: ${id}`);
  return ms;
}

/** Dasselbe, aber ohne zu werfen: `null` heisst „dieses Schema kenne ich
 *  nicht". Der Vergleich unten braucht das, weil er in einem `Array.sort`
 *  laeuft — dort reisst eine Ausnahme nicht nur den Vergleich ab, sondern
 *  die ganze Listendarstellung. Genau so ist der Fehler am 2026-08-31
 *  aufgetreten: die vorlaeufige `tmp-`-ID war ein Schema, das hier nicht
 *  vorgesehen war, und `BigInt` warf mitten im Sortieren.
 *
 *  Wer ein VIERTES Schema einfuehrt, traegt es hier ein. Der `null`-Zweig
 *  ist ein Auffangnetz gegen den Absturz, keine Einladung, sich darauf zu
 *  verlassen: er ordnet nur noch, er versteht nichts. */
function zeitOderNull(id: string): bigint | null {
  if (istVorlaeufig(id)) {
    const rest = id.slice(VORLAEUFIG_PRAEFIX.length);
    const trenner = rest.indexOf('-');
    const ms = trenner === -1 ? rest : rest.slice(0, trenner);
    return istZiffernfolge(ms) ? BigInt(ms) : null;
  }
  if (!istZiffernfolge(id)) return null;
  if (id.length === LOKALE_ID_LAENGE) {
    return BigInt(id.slice(0, LOKALE_ID_ZEIT_STELLEN));
  }
  return (BigInt(id) >> SNOWFLAKE_ZEIT_SHIFT) + SNOWFLAKE_EPOCH_MS;
}

/** Vergleicht zwei IDs ueber ihre eingebettete Zeit, mit der rohen Zahl als
 *  Tiebreak bei gleicher Millisekunde. Liefert -1/0/1 wie ein `Array.sort`-
 *  Komparator. */
export function vergleicheSnowflakeArtigeId(a: string, b: string): number {
  const za = zeitOderNull(a);
  const zb = zeitOderNull(b);

  // Unbekanntes Schema: nach hinten, untereinander lexikografisch. Bewusst
  // deterministisch statt „jetzt" — ein Komparator, dessen Ergebnis sich
  // zwischen zwei Aufrufen aendert, zerstoert die Sortierung selbst.
  if (za === null || zb === null) {
    if (za !== null) return -1;
    if (zb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (za !== zb) return za < zb ? -1 : 1;

  // Gleiche Millisekunde. Die vorlaeufige Kopie gehoert hinter die
  // bestaetigte Nachricht: sie ist per Definition das juengere Ereignis, und
  // die Liste ersetzt sie ohnehin gleich per Nonce (MessageList.svelte).
  const va = istVorlaeufig(a);
  const vb = istVorlaeufig(b);
  if (va !== vb) return va ? 1 : -1;
  if (va && vb) return a < b ? -1 : a > b ? 1 : 0;

  // Beides Ziffernfolgen — hier traegt die rohe Zahl wieder.
  const na = BigInt(a);
  const nb = BigInt(b);
  return na < nb ? -1 : na > nb ? 1 : 0;
}
