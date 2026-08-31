/**
 * Klartext-Export (Etappe E10, Entwurf §6.6) — reine Rechnung: aus lokal
 * vorliegenden Nachrichten und Anhang-Angaben wird eine Dateiliste für ein
 * Export-Verzeichnis. Importfrei, damit Nodes Testläufer sie direkt prüft
 * (keine Datenbank, kein `$state()` auf Modulebene — s. CLAUDE.md „Die
 * Falle").
 *
 * Was diese Datei NICHT tut: keine IndexedDB lesen, keine Bytes anfassen,
 * keinen Ordner öffnen. `ExportBlock.svelte` liest den Bestand
 * (`verlauf/db.ts::verlaufAlleLesen`, `anhangBytesLesen`), löst Kanal- und
 * Autorennamen über die vorhandenen Stores auf und übergibt hier fertige,
 * strukturell einfache Objekte — genau das macht die Rechnung ohne Import
 * testbar. `art: 'anhang'` trägt deshalb nur die Anhang-ID, nicht die Bytes
 * selbst: Blobs gehören nicht in eine importfreie, mit `assert.deepEqual`
 * prüfbare Rechnung.
 *
 * **Dateinamen sind gefährlich** (Aufgabenstellung Punkt 1): ein Absender
 * bestimmt Filename und Anzeigename frei — `../../etc/passwd`, ein
 * Windows-reservierter Name (`CON`, `LPT1`, …), Steuerzeichen, zwei Anhänge
 * mit demselben Namen im selben Kanal. `bereinigeSegment`/`eindeutigMachen`
 * unten sind deshalb eigene, isoliert testbare Funktionen statt Streuung in
 * die Komponente.
 */

export type ExportAnhang = {
  id: string;
  dateiname: string | null;
  /** `false`, wenn die Bytes lokal nicht (mehr) vorliegen — der Grund dafür
   *  gehört in die Übersicht, nicht in ein stilles Weglassen (Punkt 3). */
  verfuegbar: boolean;
  grund?: string;
};

export type ExportNachricht = {
  kanalId: string;
  /** Anzeigename des Kanals — vom Aufrufer aufgelöst (DM-Partner, Gruppenname). */
  kanalName: string;
  nachrichtId: string;
  /** Anzeigename des Autors — vom Aufrufer aufgelöst. */
  autorName: string;
  inhalt: string;
  /** ISO 8601. */
  erstelltAm: string;
  geloescht: boolean;
  anhaenge: ExportAnhang[];
};

export type ExportDatei =
  | { art: 'text'; pfad: string; inhalt: string }
  | { art: 'anhang'; pfad: string; anhangId: string };

export type ExportFehlstelle = { kanalName: string; dateiname: string; grund: string };

export type ExportErgebnis = {
  dateien: ExportDatei[];
  fehlstellen: ExportFehlstelle[];
};

const WINDOWS_RESERVIERT = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/** Grosszügig, aber weit unter jeder Dateisystem-Grenze (Windows: 255 pro
 *  Segment) — auch mit einem angehängten `_` und Zähler-Suffix noch sicher. */
const MAX_SEGMENT_LAENGE = 120;

/**
 * Macht aus einem beliebigen, potenziell feindlichen String EIN sicheres
 * Pfadsegment (Ordner- oder Dateiname, nie ein ganzer Pfad). `../` und
 * absolute Pfade sind danach wirkungslos: jeder `/`/`\` wird ersetzt, es
 * bleibt also kein Trennzeichen übrig, über das ein Segment die Ebene
 * verlassen könnte. `ersatz` greift, wenn nichts Brauchbares übrig bleibt.
 */
/** Ersetzt Steuerzeichen (Codepunkt < 32, z. B. eingeschleuste Zeilenumbrüche)
 *  durch `_` — bewusst als Zeichen-für-Zeichen-Filter statt als Hex-Escape in
 *  einer Regex geschrieben (letzteres ist beim ersten Anlauf dieser Datei als
 *  echtes Steuerzeichen im Quelltext gelandet statt als Text stehenzubleiben). */
function ohneSteuerzeichen(text: string): string {
  let ergebnis = '';
  for (const zeichen of text) {
    ergebnis += (zeichen.codePointAt(0) ?? 0) < 32 ? '_' : zeichen;
  }
  return ergebnis;
}

export function bereinigeSegment(roh: string | null | undefined, ersatz: string): string {
  let name = (roh ?? '').trim();
  // Pfadtrenner entschärfen — danach kann kein Segment mehr aus dem
  // Export-Verzeichnis hinauszeigen.
  name = name.replace(/[\\/]+/g, '_');
  // Unter Windows verbotene Zeichen + Steuerzeichen.
  name = ohneSteuerzeichen(name.replace(/[<>:"|?*]/g, '_'));
  // Punkte/Leerzeichen am Ende sind unter Windows ungültig und werden vom
  // Explorer sonst stillschweigend entfernt (dann stimmt der Name nicht
  // mehr mit dem hier berechneten überein).
  name = name.replace(/[. ]+$/g, '');
  if (name === '' || name === '.' || name === '..') name = ersatz;
  if (name.length > MAX_SEGMENT_LAENGE) name = name.slice(0, MAX_SEGMENT_LAENGE);

  const punkt = name.lastIndexOf('.');
  const stamm = punkt > 0 ? name.slice(0, punkt) : name;
  if (WINDOWS_RESERVIERT.has(stamm.toUpperCase())) name = `_${name}`;
  return name;
}

/**
 * Hängt bei einer Kollision einen Zähler an — `datei.txt` → `datei (2).txt`.
 * `vergeben` wird um den zurückgegebenen Namen erweitert (Aufrufer reicht
 * dasselbe Set für alle Namen desselben Verzeichnisses durch).
 */
export function eindeutigMachen(name: string, vergeben: Set<string>): string {
  if (!vergeben.has(name)) {
    vergeben.add(name);
    return name;
  }
  const punkt = name.lastIndexOf('.');
  const stamm = punkt > 0 ? name.slice(0, punkt) : name;
  const endung = punkt > 0 ? name.slice(punkt) : '';
  let zaehler = 2;
  let kandidat = `${stamm} (${zaehler})${endung}`;
  while (vergeben.has(kandidat)) {
    zaehler += 1;
    kandidat = `${stamm} (${zaehler})${endung}`;
  }
  vergeben.add(kandidat);
  return kandidat;
}

const ISO_TAG = /^\d{4}-\d{2}-\d{2}/;
const ISO_ZEIT = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/;

/** `YYYY-MM-DD` aus einem ISO-Zeitstempel, oder ein Ersatz für Unlesbares —
 *  eine kaputte Zeile darf den Export nicht abbrechen. */
function tagVon(iso: string): string {
  const treffer = ISO_TAG.exec(iso);
  return treffer ? treffer[0] : 'unbekanntes-datum';
}

function zeitVon(iso: string): string {
  const treffer = ISO_ZEIT.exec(iso);
  return treffer ? treffer[1] : '--:--:--';
}

function nachrichtZeile(n: ExportNachricht): string {
  const inhalt = n.geloescht ? '[gelöscht]' : n.inhalt;
  const anhangHinweise = n.anhaenge.map((a) => {
    const name = a.dateiname ?? a.id;
    return a.verfuegbar ? ` [Anhang: ${name}]` : ` [Anhang: ${name} — nicht verfügbar]`;
  });
  return `[${zeitVon(n.erstelltAm)}] ${n.autorName}: ${inhalt}${anhangHinweise.join('')}`;
}

type KanalGruppe = {
  kanalId: string;
  kanalName: string;
  nachrichten: ExportNachricht[];
};

function gruppiereNachKanal(nachrichten: ExportNachricht[]): KanalGruppe[] {
  const reihenfolge: string[] = [];
  const nachId = new Map<string, KanalGruppe>();
  for (const n of nachrichten) {
    let gruppe = nachId.get(n.kanalId);
    if (!gruppe) {
      gruppe = { kanalId: n.kanalId, kanalName: n.kanalName, nachrichten: [] };
      nachId.set(n.kanalId, gruppe);
      reihenfolge.push(n.kanalId);
    }
    gruppe.nachrichten.push(n);
  }
  return reihenfolge.map((id) => nachId.get(id)!);
}

function gruppiereNachTag(nachrichten: ExportNachricht[]): { tag: string; zeilen: string[] }[] {
  const sortiert = [...nachrichten].sort((a, b) => a.erstelltAm.localeCompare(b.erstelltAm));
  const reihenfolge: string[] = [];
  const nachTag = new Map<string, string[]>();
  for (const n of sortiert) {
    const tag = tagVon(n.erstelltAm);
    let zeilen = nachTag.get(tag);
    if (!zeilen) {
      zeilen = [];
      nachTag.set(tag, zeilen);
      reihenfolge.push(tag);
    }
    zeilen.push(nachrichtZeile(n));
  }
  return reihenfolge.map((tag) => ({ tag, zeilen: nachTag.get(tag)! }));
}

function zeitraum(nachrichten: ExportNachricht[]): string {
  const tage = nachrichten.map((n) => tagVon(n.erstelltAm)).sort();
  if (tage.length === 0) return '–';
  const von = tage[0];
  const bis = tage[tage.length - 1];
  return von === bis ? von : `${von} bis ${bis}`;
}

function baueUebersicht(gruppen: KanalGruppe[], fehlstellen: ExportFehlstelle[]): string {
  const zeilen: string[] = ['Pulse — Klartext-Export', ''];
  if (gruppen.length === 0) {
    zeilen.push('Keine Nachrichten im lokalen Archiv.');
  }
  for (const g of gruppen) {
    const fehlendeImKanal = fehlstellen.filter((f) => f.kanalName === g.kanalName).length;
    zeilen.push(
      `${g.kanalName}: ${g.nachrichten.length} Nachricht(en), ${zeitraum(g.nachrichten)}` +
        (fehlendeImKanal > 0 ? `, ${fehlendeImKanal} Anhang/Anhänge fehlt/fehlen` : '')
    );
  }
  zeilen.push('');
  if (fehlstellen.length === 0) {
    zeilen.push('Alle Anhänge vollständig exportiert.');
  } else {
    zeilen.push('Fehlende Anhänge:');
    for (const f of fehlstellen) {
      zeilen.push(`- ${f.kanalName} / ${f.dateiname}: ${f.grund}`);
    }
  }
  return zeilen.join('\n') + '\n';
}

/**
 * Baut die vollständige Dateiliste eines Klartext-Exports. Deterministisch
 * (Reihenfolge folgt dem ersten Auftreten der Kanäle/Tage in `nachrichten`,
 * innerhalb eines Tages nach Zeitstempel) — derselbe Bestand ergibt immer
 * dieselbe Liste, das macht den Export mit `assert.deepEqual` prüfbar.
 */
export function baueKlartextExport(nachrichten: ExportNachricht[]): ExportErgebnis {
  const gruppen = gruppiereNachKanal(nachrichten);
  const vergebeneOrdner = new Set<string>();
  const fehlstellen: ExportFehlstelle[] = [];
  const dateien: ExportDatei[] = [];

  for (const gruppe of gruppen) {
    const ordner = eindeutigMachen(
      bereinigeSegment(gruppe.kanalName, `kanal-${gruppe.kanalId}`),
      vergebeneOrdner
    );
    const vergebeneAnhaenge = new Set<string>();

    for (const { tag, zeilen } of gruppiereNachTag(gruppe.nachrichten)) {
      dateien.push({ art: 'text', pfad: `${ordner}/${tag}.txt`, inhalt: zeilen.join('\n') + '\n' });
    }

    for (const n of gruppe.nachrichten) {
      for (const a of n.anhaenge) {
        if (!a.verfuegbar) {
          fehlstellen.push({
            kanalName: gruppe.kanalName,
            dateiname: a.dateiname ?? a.id,
            grund: a.grund ?? 'lokal nicht vorhanden'
          });
          continue;
        }
        const name = eindeutigMachen(
          bereinigeSegment(a.dateiname, `anhang-${a.id}`),
          vergebeneAnhaenge
        );
        dateien.push({ art: 'anhang', pfad: `${ordner}/anhaenge/${name}`, anhangId: a.id });
      }
    }
  }

  dateien.unshift({ art: 'text', pfad: 'uebersicht.txt', inhalt: baueUebersicht(gruppen, fehlstellen) });
  return { dateien, fehlstellen };
}
