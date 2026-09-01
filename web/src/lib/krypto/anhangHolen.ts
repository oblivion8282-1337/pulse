/**
 * Verschluesselte Anhaenge holen und oeffnen (Etappe E) — die Empfaengerseite
 * von `attachments/uploadVerschluesselt.ts`.
 *
 * **Seit Design §11.1 ist die eigene Cloud die erste Quelle, nicht Pulse.**
 * Beim Versenden legt der Server das Chiffrat in den Archiv-Ordner jedes
 * Beteiligten und gibt danach seine eigene Kopie frei. Ein Empfaenger holt
 * die Datei deshalb aus SEINEM Laufwerk — auch noch in 50 Tagen. Pulses
 * Aufbewahrung spielt fuer solche Anhaenge keine Rolle mehr, und die Route
 * `POST /postfach/anhaenge/{id}/abrufadresse` antwortet fuer sie mit 410
 * (`anhang_im_laufwerk`) statt mit einer Adresse auf geloeschte Bytes.
 *
 * **Der alte Weg bleibt als Rueckfall, und mit ihm seine Regel:** hat die
 * Verteilung nicht stattgefunden (Anhang von vor der Umstellung, oder ein
 * Beteiligter ohne Laufwerk), haelt Pulse den Klumpen wie bisher — dann gilt
 * weiterhin, was in `empfangen.ts` steht: **geholt wird VOR der Quittung.**
 * Das Abrufrecht haengt an der eigenen offenen Zustellung
 * (`postfach_anhaenge.py::darf_anhang_abrufen`), und der Klumpen faellt,
 * sobald die letzte Zustellung quittiert ist
 * (`postfach_pflege.py::sweep_verwaiste_anhaenge`). Wer in diesem Fall erst
 * quittiert und dann laedt, laedt ins Leere.
 *
 * Daraus folgt der dritte Teil: was geholt wurde, wird LOKAL abgelegt
 * (`verlauf/db.ts`). `anhangBlob` fragt deshalb immer zuerst den lokalen
 * Bestand und geht nur beim ersten Mal ans Netz.
 *
 * Die Geraeteangabe ist dieselbe wie beim Abholen/Quittieren
 * (`geraeteKennung.ts`). Sie sagt dem Server, WESSEN Zustellung er pruefen
 * soll — das Recht selbst haengt an dieser Zustellung, nicht an der Angabe.
 */

import type { Attachment, Message } from '../api/types';
import { postfachApi } from '../api/postfach';
import { serversStore } from '../api/servers.svelte';
import { archivAbruf } from '../api/ablageArchiv';
import { anhangArchivPfad } from '../ablage/anhangArchivPfad';
import { anhangBytesLesen, anhangBytesSichern } from '../verlauf/db';
import { entschluessele, schluesselAusText } from './anhangKrypto';
import { sichererBlobTyp } from './sichererBlobTyp';
import { geraeteKennung } from './geraeteKennung';

/** Typ des Vorschaubildes — `attachments/vorschaubild.ts` erzeugt immer WebP.
 *  Steht hier noch einmal, weil der Empfaenger die Datei nicht importiert
 *  (sie haengt an `document`/Canvas) und der Typ am Blob haengen muss, damit
 *  `<img>` ihn anzeigt. */
const VORSCHAU_TYP = 'image/webp';

// DMs sind heute cloud-only — s. `api/keys.ts` Modulkopf.
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Holt die kurzlebigen signierten Adressen fuer EINEN Anhang. Wirft, wenn
 *  sich die eigene Geraetekennung nicht ermitteln laesst (nicht angemeldet)
 *  oder der Server das Recht verweigert (404 — keine offene Zustellung
 *  mehr). */
async function adressenHolen(anhangId: string): Promise<{ url: string; thumb: string | null }> {
  const antwort = await postfachApi.anhangAdresse(
    anhangId,
    { device_pubkey: await geraeteKennung() },
    cloudRoute()
  );
  return { url: antwort.url, thumb: antwort.thumb_url ?? null };
}

/** Entschluesselt einen bereits geholten Klumpen. Der Typ kommt aus dem
 *  verschluesselten Kopf des ABSENDERS und wird heruntergestuft, bevor
 *  daraus eine `blob:`-Adresse werden kann (s. `sichererBlobTyp.ts`). */
async function klumpenEntpacken(
  klumpen: Uint8Array,
  schluesselText: string,
  typ: string
): Promise<Blob> {
  const klartext = await entschluessele(schluesselAusText(schluesselText), klumpen);
  return new Blob([klartext as unknown as BlobPart], { type: sichererBlobTyp(typ) });
}

/**
 * Der Anhang aus dem EIGENEN Archiv-Laufwerk — der Weg, den Design §11.1
 * zum Regelfall macht.
 *
 * Beim Versenden legt Pulse das Chiffrat in den Cloud-Ordner jedes
 * Beteiligten und gibt danach seine eigene Kopie frei. Wer den Anhang erst
 * in 50 Tagen oeffnet, findet ihn deshalb hier — und nur hier.
 *
 * **Byte-gleich mit dem, was frueher bei Pulse lag**: derselbe AES-GCM-
 * Klumpen, ohne zweite Huelle. Es oeffnet ihn derselbe Schluessel aus
 * demselben Umschlag; der Server hat ihn nur weitergereicht.
 *
 * `null` heisst „dort liegt sie nicht" — bei einem Anhang von vor der
 * Umstellung ist das der Normalfall, und der Aufrufer nimmt den Pulse-Weg.
 * Ein Fehler beim Abruf (Laufwerk gerade nicht erreichbar) wird
 * gleichbehandelt: der Rueckfall ist dann die bessere Antwort als ein
 * Abbruch.
 */
async function ausLaufwerk(
  anhangId: string,
  schluesselText: string,
  typ: string,
  vorschau: boolean
): Promise<Blob | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await archivAbruf(anhangArchivPfad(anhangId, vorschau));
  } catch {
    return null;
  }
  if (!bytes) return null;
  // Ein Entschluesselungsfehler wird hier NICHT geschluckt: die Bytes lagen
  // da, trugen aber nicht den erwarteten Inhalt. Das ist kein „noch nicht
  // verteilt", sondern ein echter Fehler — und genau die Sorte, die still
  // zu einem leeren Platzhalter wuerde, wenn man sie auf `null` abbildet.
  return klumpenEntpacken(bytes, schluesselText, typ);
}

async function klumpenOeffnen(url: string, schluesselText: string, typ: string): Promise<Blob> {
  // `credentials: 'omit'` wie in `AutoRefreshImage`: die Adresse traegt ihre
  // Berechtigung selbst, ein mitgeschicktes Cookie wuerde die MinIO-Signatur
  // nur verkomplizieren.
  const antwort = await fetch(url, { credentials: 'omit' });
  if (!antwort.ok) throw new Error(`Anhang ${antwort.status}`);
  return klumpenEntpacken(new Uint8Array(await antwort.arrayBuffer()), schluesselText, typ);
}

/**
 * Holt Datei UND Vorschaubild eines Anhangs, entschluesselt beide und legt
 * sie lokal ab. **Vor der Quittung aufrufen** (s. Modulkopf).
 *
 * Nimmt die Anzeige-Form (`Attachment`) statt der Nutzlast-Form
 * (`AnhangAngabe`), weil der Aufrufer (`empfangen.ts`) zu diesem Zeitpunkt
 * die fertige Nachricht in der Hand hat — die Nutzlast-Form zurueck-
 * zuuebersetzen waere dieselbe Zuordnung ein zweites Mal.
 *
 * Ist lokal schon etwas da, passiert nichts — das deckt den Absender ab (der
 * seine Bytes beim Hochladen selbst abgelegt hat) und einen zweiten
 * Abholversuch derselben Nachricht.
 *
 * **Reihenfolge seit Design §11.1: erst das eigene Laufwerk, dann Pulse.**
 * Der Regelfall ist das Laufwerk — Pulse hat seine Kopie nach dem Verteilen
 * freigegeben. Der Pulse-Weg bleibt als Rueckfall fuer Anhaenge von vor der
 * Umstellung und fuer den Fall, dass die Verteilung seinerzeit nicht lief
 * (dann haelt Pulse die Bytes unveraendert weiter, s.
 * `ablage_anhang_verteilung.py`).
 */
export async function anhangSichern(kanalId: string, anhang: Attachment): Promise<void> {
  if (!anhang.verschluesselt || !anhang.schluessel) return;
  if (await anhangBytesLesen(anhang.id)) return;
  const typ = anhang.mime ?? 'application/octet-stream';

  const ausEigenem = await ausLaufwerk(anhang.id, anhang.schluessel, typ, false);
  if (ausEigenem) {
    const vorschau = anhang.thumb_schluessel
      ? await ausLaufwerk(anhang.id, anhang.thumb_schluessel, VORSCHAU_TYP, true)
      : null;
    await anhangBytesSichern({ id: anhang.id, kanalId, daten: ausEigenem, vorschau });
    return;
  }

  const adressen = await adressenHolen(anhang.id);
  const daten = await klumpenOeffnen(adressen.url, anhang.schluessel, typ);
  let vorschau: Blob | null = null;
  if (anhang.thumb_schluessel && adressen.thumb) {
    vorschau = await klumpenOeffnen(adressen.thumb, anhang.thumb_schluessel, VORSCHAU_TYP);
  }
  await anhangBytesSichern({ id: anhang.id, kanalId, daten, vorschau });
}

/**
 * Die Bytes eines verschluesselten Anhangs zum Anzeigen — lokal zuerst.
 *
 * Drei Quellen in dieser Reihenfolge: lokal, eigenes Archiv-Laufwerk
 * (Design §11.1), Pulse. Die mittlere ist seit der Umstellung der
 * Regelfall — Pulse gibt seine Kopie frei, sobald sie in allen Laufwerken
 * liegt.
 *
 * `null`, wenn es sie in keiner der drei gibt: der Regelfall dafuer ist ein
 * Anhang von VOR der Umstellung, dessen Abholung seinerzeit fehlschlug und
 * dessen Klumpen inzwischen mit der letzten Zustellung gefallen ist. Die
 * Oberflaeche zeigt dann ihren neutralen Platzhalter — der Aufrufer soll das
 * NICHT als Fehler behandeln, es ist ein endgueltiger, nicht behebbarer
 * Zustand.
 */
export async function anhangBlob(
  anhangId: string,
  schluesselText: string,
  typ: string,
  thumb: boolean
): Promise<Blob | null> {
  const lokal = await anhangBytesLesen(anhangId);
  if (lokal) {
    // Ohne gespeicherte Vorschau (Sicherungs-Wiederherstellung schreibt
    // keine) faellt die Kachel auf die vollen Bytes zurück, statt leer
    // zu bleiben.
    return thumb ? (lokal.vorschau ?? lokal.daten) : lokal.daten;
  }
  const wirkTyp = thumb ? VORSCHAU_TYP : typ;
  try {
    const ausEigenem = await ausLaufwerk(anhangId, schluesselText, wirkTyp, thumb);
    if (ausEigenem) return ausEigenem;
    const adressen = await adressenHolen(anhangId);
    const url = thumb ? adressen.thumb : adressen.url;
    if (!url) return null;
    return await klumpenOeffnen(url, schluesselText, wirkTyp);
  } catch {
    // Serverweg tot (Zustellung gefallen / verschlüsselter Anhang, den der
    // Server nie sah): letzter Ausweg ist das Sicherungs-Archiv, wenn
    // dieses Gerät es geöffnet hat. Dynamischer Import, damit der
    // Sicherungs-Code nicht in jedem Nachrichtenlauf mitgeladen wird.
    const { archivAnhangHolen } = await import('$lib/sicherung/archivAnhang');
    try {
      return await archivAnhangHolen(anhangId);
    } catch {
      return null;
    }
  }
}

/**
 * Holt die Bytes aller verschluesselten Anhaenge eines Kanals — **vor der
 * Quittung**, s. Modulkopf „Anhaenge".
 *
 * Ein Fehlschlag ist hier BEWUSST nicht toedlich und haelt die Quittung nicht
 * auf. Die Abwaegung dahinter, ausgeschrieben, weil sie nicht offensichtlich
 * ist: wuerde ein Fehlschlag die Gruppe unquittiert lassen, kaeme dieselbe
 * Zustellung im naechsten Zyklus zurueck — der Klartext liegt dann aber schon
 * lokal, `zustellungOeffnen` erkennt sie ueber `verlaufSchonAbgelegt` als
 * „schon abgelegt" und quittiert sie OHNE einen zweiten Anhang-Versuch (die
 * Olm-Sitzung ist laengst weitergedreht, ein erneutes Entschluesseln ist
 * ausgeschlossen). Der zusaetzliche Zyklus braechte den Anhang also nicht
 * zurueck, wuerde aber jede Nachricht des Kanals einen Umlauf lang als
 * unzugestellt fuehren. Der Text ist das Wertvollere und darf nicht am
 * Anhang haengen.
 *
 * Was der Nutzer stattdessen sieht: die Kachel bleibt, mit Namen und Groesse,
 * und zeigt den neutralen Platzhalter (`anhangBlob` gibt `null`).
 */
export async function anhaengeHolen(kanalId: string, nachrichten: Message[]): Promise<void> {
  for (const nachricht of nachrichten) {
    for (const anhang of nachricht.attachments ?? []) {
      try {
        await anhangSichern(kanalId, anhang);
      } catch {
        // s. Docstring — nicht toedlich, nichts zu protokollieren (jede
        // Angabe daraus waere ein Dateiname oder eine Kennung).
      }
    }
  }
}
