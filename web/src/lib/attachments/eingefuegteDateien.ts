/**
 * Welche Dateien stecken in einem Einfuege-Vorgang? — reine Rechnung,
 * importfrei, damit Nodes eingebauter Testlaeufer sie prueft (s. CLAUDE.md
 * „Die Falle"). Ausgezogen aus `MessageInput.svelte`, das ueber der
 * Groessen-Grenze lag.
 *
 * Zwei Quellen, und beide sind noetig:
 *
 *  - `items` mit `kind === 'file'`: ein eingefuegtes BILD (Bildschirmfoto)
 *    liegt nur hier, als Bytes in der Zwischenablage, ohne Datei auf der
 *    Platte. Genau das macht es im abgeschotteten Electron-Renderer lesbar,
 *    wo eine GEZOGENE Datei (nur ein Pfad) es nicht ist.
 *  - `files`: eine kopierte Datei, die als Datei ankommt.
 *
 * Verworfen wird alles mit Groesse 0 — im abgeschotteten Renderer erscheint
 * eine kopierte Datei-REFERENZ so, und ein leerer Upload endet in einer 422.
 * Die Entdopplung ueber (Name, Groesse) verhindert, dass dieselbe Datei aus
 * beiden Quellen zweimal hochgeladen wird.
 */

/** Der Ausschnitt von `DataTransferItem`, den diese Rechnung braucht — als
 *  eigener Typ, damit ein Test sie ohne echtes `DataTransfer` fuettern kann. */
export type EinfuegeEintrag = {
  kind: string;
  type: string;
  getAsFile(): File | null;
};

export function dateienAusEinfuegen(
  eintraege: readonly EinfuegeEintrag[],
  dateien: readonly File[]
): File[] {
  const gesammelt: File[] = [];
  for (const eintrag of eintraege) {
    if (eintrag.kind === 'file' && eintrag.type.startsWith('image/')) {
      const datei = eintrag.getAsFile();
      if (datei && datei.size > 0) gesammelt.push(datei);
    }
  }
  for (const datei of dateien) {
    if (
      datei.size > 0 &&
      !gesammelt.some((g) => g.name === datei.name && g.size === datei.size)
    ) {
      gesammelt.push(datei);
    }
  }
  return gesammelt;
}
