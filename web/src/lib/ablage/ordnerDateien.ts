/**
 * Dateinamen-Rechnung fuer den Kanal-Ordner (`GET
 * /channels/{id}/ablage/ordner`) — der Server legt jeden Nachrichten-
 * Umschlag als `<nutzlastId>.puls` ab (s. `api/ablageKanalOrdner.ts`).
 *
 * Die Nutzlast-ID ist eine Snowflake — Groessen jenseits von `Number` sind
 * der Normalfall, nicht der Ausnahmefall (s. CLAUDE.md „Snowflake-IDs als
 * Strings"). Sortiert wird deshalb ueber `BigInt`, nicht als Zeichenkette
 * (sonst stuende "10.puls" vor "9.puls") und nicht ueber `Number`
 * (verliert ab 2^53 Praezision).
 *
 * Importfrei, damit Nodes eingebauter Testlaeufer die Datei ohne Bundler
 * prueft (s. CLAUDE.md „Die Falle").
 */

const ENDUNG = '.puls';

/** Liest die Nutzlast-ID aus einem Dateinamen des Ordners — `null`, wenn
 *  der Name nicht dem Muster `<ziffern>.puls` entspricht (fremde Datei im
 *  Ordner, oder ein spaeteres Format). */
export function nutzlastIdAusName(name: string): string | null {
  if (!name.endsWith(ENDUNG)) return null;
  const stamm = name.slice(0, -ENDUNG.length);
  if (stamm.length === 0 || !/^[0-9]+$/.test(stamm)) return null;
  return stamm;
}

/** Sortiert Dateinamen numerisch aufsteigend nach ihrer Nutzlast-ID —
 *  Fremdnamen (kein `<ziffern>.puls`) fallen raus, nicht nur ans Ende. */
export function sortiereNamen(namen: readonly string[]): string[] {
  const paare: Array<[bigint, string]> = [];
  for (const name of namen) {
    const id = nutzlastIdAusName(name);
    if (id === null) continue;
    paare.push([BigInt(id), name]);
  }
  paare.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return paare.map(([, name]) => name);
}
