/**
 * Generische "verarbeite bis Abbruch"-Schleife fuer `postfachZyklus`
 * (`empfangen.ts`) — importfrei, damit Nodes Testlaeufer die Abbruch-Logik
 * direkt prueft, ohne den WASM-/IndexedDB-/Cert-Importkegel von
 * `empfangen.ts` zu brauchen (s. CLAUDE.md „Die Falle").
 *
 * Bughunt 2026-08-28, FIX 2: `postfachZyklus` teilt EIN geladenes
 * `Identitaet`-Objekt ueber die ganze Schleife. Scheitert das atomare
 * Konto+Sitzungs-Sichern fuer eine Zustellung, bleibt `ident` mit einer
 * verbrauchten, aber nicht durabel gesicherten Mutation zurueck — eine
 * SPAETERE erfolgreiche Zustellung wuerde diesen Zwischenstand sonst
 * kumulativ mit einfrieren, und der Einmalschluessel der ersten Zustellung
 * waere fuer immer weg, ohne dass je eine Sitzung fuer sie gelandet ist.
 * `verarbeiteBisAbbruch` bricht deshalb NACH dem ersten Element ab, dessen
 * Fehler `istAbbruchgrund` als Abbruchgrund erkennt — bereits erfolgreich
 * verarbeitete Elemente bleiben im Ergebnis, alle nachfolgenden werden gar
 * nicht erst versucht. Jeder andere Fehler wird unveraendert weitergereicht
 * (kein stilles Verschlucken) — nur der eine, konkrete Grund darf die
 * Schleife anhalten.
 */

export type SchleifenErgebnis<R> = {
  ergebnisse: R[];
  abgebrochen: boolean;
};

export async function verarbeiteBisAbbruch<E, R>(
  elemente: E[],
  verarbeite: (element: E) => Promise<R>,
  istAbbruchgrund: (err: unknown) => boolean
): Promise<SchleifenErgebnis<R>> {
  const ergebnisse: R[] = [];
  for (const element of elemente) {
    try {
      ergebnisse.push(await verarbeite(element));
    } catch (err) {
      if (istAbbruchgrund(err)) {
        return { ergebnisse, abgebrochen: true };
      }
      throw err;
    }
  }
  return { ergebnisse, abgebrochen: false };
}
