/**
 * Verarbeitet Zustellungen einzeln, mit Wiederherstellung nach einem
 * bestimmten Fehlergrund — importfrei, damit Nodes Testlaeufer die Logik
 * direkt prueft, ohne den WASM-/IndexedDB-/Cert-Importkegel von
 * `empfangen.ts` zu brauchen (s. CLAUDE.md „Die Falle").
 *
 * Bughunt-Runde 3, FIX 2: `postfachZyklus` (`empfangen.ts`) teilt EIN
 * geladenes `Identitaet`-Objekt ueber die ganze Abholschleife. Scheitert das
 * atomare Konto+Sitzungs-Sichern fuer eine Zustellung, bleibt dieses Objekt
 * mit einer verbrauchten, aber nicht durabel gesicherten Mutation zurueck —
 * eine SPAETERE erfolgreiche Zustellung wuerde diesen Zwischenstand sonst
 * kumulativ mit einfrieren, und der Einmalschluessel der ersten Zustellung
 * waere fuer immer weg, ohne dass je eine Sitzung fuer sie gelandet ist.
 *
 * Die VORHERIGE Fassung dieser Datei (Bughunt-Runde 2) hat deshalb die
 * GESAMTE restliche Schleife abgebrochen, sobald das passierte. `POST
 * /postfach/abholen` liefert nach stabiler ID-Reihenfolge (FIFO) — eine
 * EINZELNE dauerhaft scheiternde Zustellung (z. B. echt volle IndexedDB)
 * sortierte sich damit immer an den Anfang und blockierte JEDE Zustellung
 * dahinter, in JEDEM Kanal, bei JEDEM Zyklus, obwohl die Zustellungen sonst
 * unabhaengig sind. `verarbeiteMitWiederherstellung` behebt das: statt
 * abzubrechen, laesst sie NUR die eine betroffene Zustellung liegen
 * (unquittiert — ein spaeterer Zyklus versucht sie erneut) und ruft
 * `wiederherstellen` auf, BEVOR sie mit der naechsten weitermacht.
 * `empfangen.ts` laedt darueber ein frisches `Identitaet` aus IndexedDB (den
 * zuletzt durabel gesicherten Stand, ohne die verlorene Mutation), damit
 * keine weitere Zustellung den kompromittierten Zwischenstand einfrieren
 * kann. Jeder andere Fehler wird unveraendert weitergereicht (kein stilles
 * Verschlucken) — nur der eine, konkrete Grund darf eine Zustellung
 * ueberspringen statt die Schleife zu sprengen.
 */

export async function verarbeiteMitWiederherstellung<E, R>(
  elemente: E[],
  verarbeite: (element: E) => Promise<R>,
  istWiederherstellbar: (err: unknown) => boolean,
  wiederherstellen: () => Promise<void>
): Promise<R[]> {
  const ergebnisse: R[] = [];
  for (const element of elemente) {
    try {
      ergebnisse.push(await verarbeite(element));
    } catch (err) {
      if (!istWiederherstellbar(err)) throw err;
      // Diese eine Zustellung bleibt liegen (kein Ergebnis, keine Quittung)
      // — vor der naechsten wird der kompromittierte Zwischenstand ersetzt.
      await wiederherstellen();
    }
  }
  return ergebnisse;
}
