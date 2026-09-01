/**
 * Schreibt eine fertige `ExportDatei`-Liste (`export.ts::baueKlartextExport`)
 * tatsächlich ins Dateisystem — dieselbe File-System-Access-API wie der
 * Sync-Ordner (`ablage/syncOrdner.ts`), aber mit Unterordnern (Kanal, darin
 * `anhaenge/`), die `syncOrdner.ts::AblageVerzeichnis` nicht kennt. Deshalb
 * eine eigene, schlanke Schnittstelle statt jene zu erweitern — `syncOrdner.ts`
 * bleibt unangetastet (Vorgabe der Etappe, dort arbeitet parallel jemand
 * anders).
 *
 * Bewusst NICHT importfrei: echte Dateisystem-Zugriffe. Die Rechnung, WAS
 * geschrieben wird, steht getrennt und importfrei in `export.ts`.
 */

export interface ExportVerzeichnis {
  getDirectoryHandle(name: string, optionen?: { create?: boolean }): Promise<ExportVerzeichnis>;
  getFileHandle(
    name: string,
    optionen?: { create?: boolean }
  ): Promise<{
    createWritable(): Promise<{
      write(inhalt: Uint8Array | Blob): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
}

async function ordnerFuerPfad(wurzel: ExportVerzeichnis, segmente: string[]): Promise<ExportVerzeichnis> {
  let aktuell = wurzel;
  for (const segment of segmente) {
    aktuell = await aktuell.getDirectoryHandle(segment, { create: true });
  }
  return aktuell;
}

/** `pfad` mit `/` getrennt — die vorletzten Segmente werden als Ordner
 *  angelegt (falls nötig), das letzte ist der Dateiname. */
export async function schreibeExportDatei(
  wurzel: ExportVerzeichnis,
  pfad: string,
  inhalt: Uint8Array | Blob
): Promise<void> {
  const segmente = pfad.split('/');
  const dateiname = segmente.pop();
  if (!dateiname) return;
  const ordner = await ordnerFuerPfad(wurzel, segmente);
  const handle = await ordner.getFileHandle(dateiname, { create: true });
  const schreibbar = await handle.createWritable();
  try {
    await schreibbar.write(inhalt);
  } finally {
    await schreibbar.close();
  }
}
