/**
 * Reine Warteschlangen-Rechnung fuer `sitzungen.ts::mitSitzungssperre` —
 * importfrei, damit Nodes eingebauter Testlaeufer sie ohne den WASM-/
 * IndexedDB-Importkegel von `sitzungen.ts` prueft (s. CLAUDE.md „Die Falle").
 *
 * Der Bughunt vom 2026-08-28 (FIX 3): zwei gleichzeitige Operationen auf
 * demselben Sitzungsschluessel (zwei schnelle Sendungen, oder ein Empfang
 * waehrend eine Sendung laeuft) laden sonst dieselbe eingefrorene Sitzung,
 * ratcheten sie unabhaengig weiter, und der letzte Schreiber gewinnt — der
 * andere Ratchet-Schritt ist weg, obwohl sein Umschlag schon zugestellt
 * wurde. Ein Promise-Ketten-Mutex je Schluessel reicht dagegen: Aufgaben fuer
 * denselben Schluessel laufen streng NACHEINANDER, verschiedene Schluessel
 * bleiben unabhaengig.
 */

/** Je Schluessel eine Kette aus dem zuletzt angehaengten Versprechen. */
const sperren = new Map<string, Promise<unknown>>();

/**
 * Fuehrt `aufgabe` streng NACH jeder anderen, unter demselben `schluessel`
 * laufenden Aufgabe aus — nie gleichzeitig. Ein Fehlschlag in einer Aufgabe
 * blockiert die naechste nicht (die Sperre haengt an der ABSCHLUSSZEIT, nicht
 * am Erfolg), gibt seinen Fehler aber unveraendert an den eigenen Aufrufer
 * zurueck.
 */
export function mitSchluesselsperre<T>(schluessel: string, aufgabe: () => Promise<T>): Promise<T> {
  const vorherige = sperren.get(schluessel) ?? Promise.resolve();
  const eigene = vorherige.then(aufgabe, aufgabe);
  const kettenglied = eigene.catch(() => undefined);
  sperren.set(schluessel, kettenglied);
  void kettenglied.then(() => {
    // Nur die eigene, noch aktuelle Kette entfernen — sonst wuerde ein
    // spaeter angehaengtes Kettenglied hier faelschlich mit geraeumt.
    if (sperren.get(schluessel) === kettenglied) sperren.delete(schluessel);
  });
  return eigene;
}
