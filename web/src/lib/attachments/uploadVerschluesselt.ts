/**
 * Der VERSCHLUESSELTE Upload-Weg fuer Anhaenge in Direktnachrichten
 * (Etappe E) — Gegenstueck zu `upload.svelte.ts`, gleiche Zeilenform
 * (`PendingAttachment`), gleiche Zustandsmaschine, drei Unterschiede:
 *
 *  1. **Die Bytes werden vorher verschluesselt** (`krypto/anhangKrypto.ts`,
 *     AES-256-GCM, ein eigener Schluessel je Klumpen — Begruendung dort).
 *     Hochgeladen wird ausschliesslich der Klumpen.
 *  2. **Eine andere Route**: `POST /postfach/anhaenge/upload-url` statt
 *     `POST /channels/{id}/attachments/upload-url`. Die neue nimmt Name, Typ
 *     und Maße gar nicht entgegen — der Server soll davon nichts wissen und
 *     legt nichts davon ab. Was der Empfaenger braucht, faehrt stattdessen
 *     in der verschluesselten Nachricht mit (`AnhangAngabe`).
 *  3. **Die Klartext-Bytes bleiben lokal liegen** (`verlauf/db.ts::
 *     anhangBytesSichern`). Der Absender hat nie eine Postfach-Zustellung an
 *     sich selbst und koennte seinen eigenen Anhang deshalb NIE wieder vom
 *     Server holen (`postfach_anhaenge.py::darf_anhang_abrufen`); ohne diese
 *     lokale Kopie waere sein eigenes Bild nach dem naechsten Neustart weg.
 *
 * Der Vorschaubild-Klumpen ist im verschluesselten Weg nicht bloss huebsch:
 * der Server kennt die Maße nicht mehr, sie kommen nur noch von hier.
 */

import { postfachApi } from '$lib/api/postfach';
import { serversStore } from '$lib/api/servers.svelte';
import {
  neuerDateischluessel,
  verschluessele,
  schluesselAlsText
} from '$lib/krypto/anhangKrypto';
import type { AnhangAngabe } from '$lib/krypto/nachrichtNutzlast';
import { anhangBytesSichern, anhangBytesLoeschen } from '$lib/verlauf/db';
import { m } from '$lib/paraglide/messages.js';
import { erzeugeVorschaubild } from './vorschaubild';
import { putMitFortschritt } from './putMitFortschritt';
import { nextLocalId, type PendingAttachment } from './upload.svelte';
import { anhangBereitschaft } from './anhangBereitschaft.svelte';
import { anhangGroesseOk } from './anhangKnopfSichtbar';
import { groesseText } from '$lib/ablage/groesseText';

/** Was MinIO als Typ zu sehen bekommt — mehr als „undurchsichtige Bytes"
 *  soll der Objektspeicher ueber einen verschluesselten Anhang nicht
 *  erfahren. Muss zu `_KLUMPEN_TYP` in `routes/postfach_anhaenge.py` passen:
 *  der Typ ist in die vorsignierte Adresse eingebacken, ein PUT mit einem
 *  anderen Typ wird abgewiesen. */
const KLUMPEN_TYP = 'application/octet-stream';

// DMs sind heute cloud-only — s. `api/keys.ts` Modulkopf. Ohne diese Route
// liefe der Upload gegen den zuletzt gewaehlten Self-Host.
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Verschluesselt einen Blob mit einem frischen Schluessel. Gibt Klumpen und
 *  Schluessel (als Text) zurueck — der Schluessel wird genau EINMAL benutzt,
 *  s. `anhangKrypto.ts`. */
async function klumpenBauen(blob: Blob): Promise<{ klumpen: Blob; schluessel: string }> {
  const schluessel = neuerDateischluessel();
  const klartext = new Uint8Array(await blob.arrayBuffer());
  const bytes = await verschluessele(schluessel, klartext);
  return {
    klumpen: new Blob([bytes as unknown as BlobPart], { type: KLUMPEN_TYP }),
    schluessel: schluesselAlsText(schluessel)
  };
}

/** Ein Fehlschlag in einen Satz, den ein Nutzer versteht.
 *
 *  Die beiden Kennungen aus dem Verteil-Weg (`kein_laufwerk`,
 *  `laufwerk_*`) beschreiben etwas, wogegen der Nutzer tatsaechlich etwas
 *  tun kann — ein Laufwerk verbinden bzw. spaeter erneut versuchen. Sie
 *  bloss durchzureichen hiesse, ihm eine Server-Kennung hinzulegen. Alles
 *  Uebrige bleibt beim Rohtext: eine erfundene Erklaerung waere schlechter
 *  als eine unschoene, aber ehrliche. */
function fehlerText(err: unknown): string {
  const roh = err instanceof Error ? err.message : String(err);
  if (roh.includes('kein_laufwerk')) return m.anhang_kein_laufwerk();
  if (roh.includes('laufwerk_')) return m.anhang_laufwerk_nicht_erreichbar();
  return roh;
}

/**
 * Wie `startUpload`, aber verschluesselt. Setzt bei Erfolg `row.anhang` —
 * das ist der Teil, der spaeter in die verschluesselte Nachricht wandert
 * (`krypto/senden.ts`); `row.attachmentId` traegt dieselbe Kennung, damit der
 * Verfasser beide Wege gleich behandeln kann.
 */
export function startUploadVerschluesselt(
  channelId: string,
  file: File,
  onChange: (next: PendingAttachment) => void
): { row: PendingAttachment; abort: () => void } {
  const localId = nextLocalId();
  const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  const row: PendingAttachment = {
    localId,
    file,
    previewUrl,
    state: 'queued',
    progress: 0,
    attachmentId: null,
    errorMessage: null,
    anhang: null
  };

  let abortCurrent: (() => void) | null = null;
  let cancelled = false;
  const emit = () => onChange({ ...row });

  const run = async () => {
    try {
      // **Die Grenze VOR dem Verschluesseln** (Design §11.3). Sonst kaeme die
      // Absage erst nach Verschluesseln und Hochladen, und der Nutzer haette
      // auf einen Fehlschlag gewartet, der von Anfang an feststand. Die Zahl
      // stammt aus derselben Auskunft, die den Knopf freischaltet.
      const maxBytes = anhangBereitschaft.maxBytes(channelId);
      if (!anhangGroesseOk(file.size, maxBytes)) {
        throw new Error(m.anhang_zu_gross({ grenze: groesseText(maxBytes!) }));
      }

      const vorschau = await erzeugeVorschaubild(file);
      if (cancelled) return;

      // Verschluesseln VOR dem Anfordern der Adresse: die Adresse wird auf
      // die Groesse des KLUMPENS ausgestellt (MinIO prueft sie), und die
      // steht erst nach dem Verschluesseln fest — GCM haengt IV und Siegel
      // an, der Klumpen ist also groesser als die Datei.
      const datei = await klumpenBauen(file);
      if (cancelled) return;
      const vorschauKlumpen = vorschau ? await klumpenBauen(vorschau.blob) : null;
      if (cancelled) return;

      const adresse = await postfachApi.anhangUploadAdresse(
        {
          channel_id: channelId,
          size: datei.klumpen.size,
          has_thumb: vorschauKlumpen !== null,
          thumb_size: vorschauKlumpen?.klumpen.size ?? null
        },
        cloudRoute()
      );
      if (cancelled) return;

      row.attachmentId = adresse.id;
      row.state = 'uploading';
      emit();

      await putMitFortschritt(
        adresse.upload_url,
        datei.klumpen,
        KLUMPEN_TYP,
        (pct) => {
          row.progress = pct;
          emit();
        },
        (a) => {
          abortCurrent = a;
        }
      );
      if (cancelled) return;

      if (vorschauKlumpen && adresse.thumb_upload_url) {
        await putMitFortschritt(
          adresse.thumb_upload_url,
          vorschauKlumpen.klumpen,
          KLUMPEN_TYP,
          () => {
            /* Vorschaubilder sind klein — Zwischenstaende interessieren nicht. */
          },
          (a) => {
            abortCurrent = a;
          }
        );
        if (cancelled) return;
      }

      // **Kein Verteilen mehr (2026-09-02)**: der Klumpen bleibt im
      // Postfach und verfällt nach der Vorhaltezeit des Servers
      // (`postfach_anhang_vorhalte_tage`, Standard 15 Tage). Die
      // §11-Verteilung in die Laufwerke der Beteiligten ist ein optionaler
      // Nachschuss (`anhangVerteilen`), kein Sendeweg mehr.
      if (cancelled) return;

      // Die eigene Kopie. Vor dem `done`, weil ab dort abgeschickt werden
      // darf: eine Nachricht, deren Anhang der Absender selbst nicht mehr
      // oeffnen kann, waere ein stiller Verlust auf der eigenen Seite.
      await anhangBytesSichern({
        id: adresse.id,
        kanalId: channelId,
        daten: file,
        vorschau: vorschau?.blob ?? null
      });
      if (cancelled) return;


      row.anhang = {
        id: adresse.id,
        name: file.name,
        typ: file.type || 'application/octet-stream',
        groesse: file.size,
        schluessel: datei.schluessel,
        breite: vorschau?.origWidth ?? null,
        hoehe: vorschau?.origHeight ?? null,
        vorschau:
          vorschauKlumpen && vorschau
            ? {
                schluessel: vorschauKlumpen.schluessel,
                breite: vorschau.thumbWidth,
                hoehe: vorschau.thumbHeight
              }
            : null
      };
      row.state = 'done';
      row.progress = 100;
      emit();
    } catch (err) {
      if (cancelled) return;
      row.state = 'error';
      row.errorMessage = fehlerText(err);
      emit();
    }
  };

  void run();

  return {
    row,
    abort: () => {
      cancelled = true;
      abortCurrent?.();
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
      // Die lokale Kopie eines abgebrochenen Anhangs mitnehmen — die
      // serverseitige Huelle raeumt der Reaper nach einer Stunde weg, die
      // hier laege sonst fuer immer.
      if (row.attachmentId) void anhangBytesLoeschen(row.attachmentId).catch(() => undefined);
    }
  };
}
