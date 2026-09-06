/**
 * Orchestriert den Klartext-Export (Etappe E10): liest den lokalen Bestand,
 * löst Kanal-/Autorennamen über die vorhandenen Stores auf, baut die
 * Dateiliste (`export.ts::baueKlartextExport`, importfrei/reine Rechnung)
 * und schreibt sie über `exportSchreiber.ts` tatsächlich ins gewählte
 * Verzeichnis. `ExportBlock.svelte` bleibt dadurch reine Oberfläche.
 *
 * **Grösse (Punkt 2 der Aufgabe):** die Schreibschleife meldet nach jeder
 * Datei den Fortschritt und tritt regelmässig einen Tick ab (`setTimeout(0)`),
 * damit ein langes Archiv die Oberfläche nicht einfriert — `IndexedDB`-Reads
 * und Dateisystem-Schreibvorgänge sind ohnehin async, das reicht dem Browser
 * normalerweise schon zum Zwischenrendern, der Tick ist die zusätzliche
 * Sicherheit bei sehr vielen kleinen Dateien in Folge.
 */
import { verlaufAlleLesen, anhangBytesLesen } from '$lib/verlauf/db';
import { aktuellesKonto } from '$lib/verlauf/konto';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
import { userCache } from '$lib/stores/users.svelte';
import { baueKlartextExport, type ExportNachricht } from './export';
import { schreibeExportDatei, type ExportVerzeichnis } from './exportSchreiber';

export class KeinKontoFehler extends Error {}

export type ExportFortschritt = { fertig: number; gesamt: number };

type RohAnhang = { id: string; dateiname: string | null; verschluesselt: boolean };

function alsAnhang(roh: unknown): RohAnhang | null {
  if (typeof roh !== 'object' || roh === null) return null;
  const r = roh as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    dateiname: typeof r.filename === 'string' ? r.filename : null,
    verschluesselt: r.verschluesselt === true
  };
}

/** Namen fehlen im Cache oft noch (fremder Autor, nie gerendert) — anfragen
 *  und kurz abwarten, statt sofort mit der ID zurückzufallen. Kein Warten auf
 *  Ewigkeit: ein einzelner ausbleibender Name darf den ganzen Export nicht
 *  aufhalten, `kanalAnzeigename`/`autorAnzeigename` fallen danach auf die ID
 *  zurück. */
async function wartenAufNamen(ids: Set<string>): Promise<void> {
  const fehlend = [...ids].filter((id) => !userCache.get(id));
  if (fehlend.length === 0) return;
  for (const id of fehlend) userCache.queue(id);
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (fehlend.every((id) => userCache.get(id) !== null)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

function kanalAnzeigename(kanalId: string): string {
  const dm = directMessages.byId[kanalId];
  if (dm) {
    const u = userCache.get(dm.other_user_id);
    return u ? (u.display_name ?? u.username) : dm.other_user_id;
  }
  const gruppe = privateGruppen.byId[kanalId];
  if (gruppe) return gruppe.name;
  return kanalId;
}

function autorAnzeigename(autorId: string): string {
  const u = userCache.get(autorId);
  return u ? (u.display_name ?? u.username) : autorId;
}

const GRUND_KLARTEXT = 'unverschlüsselter Anhang — nur auf dem Server, nicht im lokalen Archiv';
const GRUND_FEHLEND = 'lokal nicht (mehr) vorhanden';

async function baueExportAnhaenge(rohAnhaenge: unknown[]): Promise<ExportNachricht['anhaenge']> {
  const ergebnis: ExportNachricht['anhaenge'] = [];
  for (const roh of rohAnhaenge) {
    const a = alsAnhang(roh);
    if (!a) continue;
    if (!a.verschluesselt) {
      ergebnis.push({ id: a.id, dateiname: a.dateiname, verfuegbar: false, grund: GRUND_KLARTEXT });
      continue;
    }
    const lokal = await anhangBytesLesen(a.id);
    ergebnis.push({
      id: a.id,
      dateiname: a.dateiname,
      verfuegbar: lokal !== undefined,
      grund: lokal !== undefined ? undefined : GRUND_FEHLEND
    });
  }
  return ergebnis;
}

/**
 * Führt den kompletten Export aus. Wirft `KeinKontoFehler`, wenn niemand
 * angemeldet ist — sonst nichts zu exportieren. `onFortschritt` wird
 * mindestens einmal vor dem ersten und einmal nach jedem Schreibvorgang
 * gerufen. Gibt die Anzahl der Fehlstellen zurück (für die Erfolgsmeldung).
 */
export async function fuehreKlartextExportAus(
  wurzel: ExportVerzeichnis,
  onFortschritt: (f: ExportFortschritt) => void
): Promise<{ fehlstellen: number }> {
  const kontoId = aktuellesKonto();
  if (kontoId === null) throw new KeinKontoFehler('kein angemeldetes Konto');

  const saetze = await verlaufAlleLesen(kontoId);

  const gebrauchteIds = new Set<string>();
  for (const s of saetze) {
    gebrauchteIds.add(s.autorId);
    const dm = directMessages.byId[s.kanalId];
    if (dm) gebrauchteIds.add(dm.other_user_id);
  }
  await wartenAufNamen(gebrauchteIds);

  const nachrichten: ExportNachricht[] = [];
  for (const satz of saetze) {
    nachrichten.push({
      kanalId: satz.kanalId,
      kanalName: kanalAnzeigename(satz.kanalId),
      nachrichtId: satz.nachrichtId,
      autorName: autorAnzeigename(satz.autorId),
      inhalt: satz.inhalt,
      erstelltAm: satz.erstelltAm,
      geloescht: satz.geloescht,
      anhaenge: await baueExportAnhaenge(satz.anhaenge ?? [])
    });
  }

  const { dateien, fehlstellen } = baueKlartextExport(nachrichten);

  let fertig = 0;
  onFortschritt({ fertig, gesamt: dateien.length });
  for (const datei of dateien) {
    if (datei.art === 'text') {
      await schreibeExportDatei(wurzel, datei.pfad, new TextEncoder().encode(datei.inhalt));
    } else {
      const lokal = await anhangBytesLesen(datei.anhangId);
      if (lokal) await schreibeExportDatei(wurzel, datei.pfad, lokal.daten);
    }
    fertig += 1;
    onFortschritt({ fertig, gesamt: dateien.length });
    if (fertig % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { fehlstellen: fehlstellen.length };
}
