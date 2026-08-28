/**
 * Holt Postfach-Zustellungen ab, entschluesselt sie und legt sie lokal ab —
 * Task 3 der Etappe D2 (`docs/superpowers/plans/2026-08-28-etappe-d2-klient-
 * verschluesselt.md`).
 *
 * Ablauf je Zustellung, unter `mitSitzungssperre` (Bughunt 2026-08-28,
 * FIX 3, s. `sitzungen.ts` Modulkopf — schuetzt gegen einen gleichzeitigen
 * Sendeversuch oder eine zweite Abholung auf derselben Sitzung):
 *
 *  1. Sitzung laden. Gibt es noch keine UND ist es ein Sitzungsaufbau
 *     (`art === 0`), ueber `sitzungEingehend` eine neue anlegen — der
 *     Klartext der ersten Nachricht kommt dabei gleich mit.
 *  2. Sitzung SICHERN — beim Sitzungsaufbau ATOMAR mit dem Account (Bughunt
 *     2026-08-28, FIX 2): `sitzungEingehend` verbraucht einen Einmalschluessel
 *     AUF DEM ACCOUNT (`&mut self` in `identitaet.rs`). Ein blosses
 *     Nachreichen von `kryptoAccountSichern` waere hier die falsche
 *     Reparatur: schlaegt danach das Sichern der Sitzung fehl, ist der
 *     Einmalschluessel vom Account verschwunden, waehrend nirgends eine
 *     Sitzung dafuer liegt — die noch unquittierte Zustellung kaeme beim
 *     naechsten Versuch zurueck und waere dann NIE MEHR zu oeffnen.
 *     `sitzungMitKontoAtomarSichern` (s. `sitzungen.ts`) schreibt deshalb
 *     beide Pickles in EINER Transaktion.
 *  3. Klartext in den lokalen Verlauf ablegen.
 *  4. **Erst DANACH quittieren** (`POST /postfach/quittung`) — die wichtigste
 *     Reihenfolge des ganzen Vorhabens. Die Quittung loescht den Umschlag auf
 *     dem Server, und es gibt keine zweite Kopie: wer vor dem Ablegen
 *     quittiert, verliert die Nachricht bei jedem Fehler zwischen beidem,
 *     unwiederbringlich.
 *
 * **Ein unlesbarer Umschlag wird NICHT quittiert.** Fehlt die Sitzung (und
 * ist es kein Sitzungsaufbau), fehlt der Curve25519-Schluessel fuer einen
 * Sitzungsaufbau, oder wirft der Krypto-Kern — die Zustellung bleibt liegen.
 * Ein voruebergehender Fehler waere sonst ein endgueltiger Verlust; die
 * serverseitige Frist raeumt sie irgendwann auf, wenn sie wirklich nie zu
 * oeffnen ist (s. Plan, „was dieser Plan NICHT loest").
 */
import type { Message } from '../api/types';
import type { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { Umschlag } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { certStore } from '../identity/cert.svelte';
import { loadKeypair } from '../identity/keypair.svelte';
import { directMessages } from '../stores/directMessages.svelte';
import { verlaufSpeichern } from '../verlauf';
import { postfachApi, type PostfachZustellung } from '../api/postfach';
import { kryptoAccountLaden } from './account.svelte';
import {
  sitzungLaden,
  sitzungSichern,
  sitzungMitKontoAtomarSichern,
  mitSitzungssperre
} from './sitzungen';
import { baueNutzlast } from './nutzlast';
import { signiereNutzlast } from './nachweis';
import { absenderErmitteln } from './absenderErmitteln';

/** Die Nachricht einer erfolgreich geoeffneten Zustellung — `null`, wenn der
 *  Absender nicht ermittelbar ist: der Server liefert keinen
 *  `absender_user_id` (Sendegeraet zwischenzeitlich abgemeldet, s.
 *  `absenderErmitteln.ts`), UND der Kanal ist lokal (noch) nicht als
 *  Rueckfall bekannt (kann bei einer brandneuen DM knapp vor dem
 *  `ready`-Rahmen passieren; die naechste Abholung holt sie dann nach, s.
 *  Modulkopf „unlesbar"). */
async function zustellungOeffnen(
  ident: Identitaet,
  z: PostfachZustellung
): Promise<Message | null> {
  const absenderUserId = absenderErmitteln(
    z.absender_user_id,
    directMessages.byId[z.channel_id]?.other_user_id
  );
  if (!absenderUserId) return null;

  return mitSitzungssperre(z.channel_id, z.absender_device_pubkey, async () => {
    try {
      let sitzung = await sitzungLaden(z.channel_id, z.absender_device_pubkey);
      let klartextBytes: Uint8Array;

      if (sitzung) {
        klartextBytes = sitzung.entschluesseln(new Umschlag(z.art, z.daten));
        // Sichern VOR dem Quittieren — s. Modulkopf.
        await sitzungSichern(z.channel_id, z.absender_device_pubkey, sitzung);
      } else {
        if (z.art !== 0 || z.absender_curve25519 === null) {
          // Laufende Nachricht ohne bekannte Sitzung, oder Sitzungsaufbau
          // ohne Identitaetsschluessel — nicht zu oeffnen, liegen lassen.
          return null;
        }
        const ergebnis = ident.sitzungEingehend(
          z.absender_curve25519,
          new Umschlag(z.art, z.daten)
        );
        sitzung = ergebnis.sitzung();
        klartextBytes = ergebnis.klartext();
        // ATOMAR mit dem Konto sichern — s. Modulkopf.
        await sitzungMitKontoAtomarSichern(ident, z.channel_id, z.absender_device_pubkey, sitzung);
      }

      return {
        // Snowflake der Zustellung: digit-only wie ein echter Server-
        // Snowflake, sortiert also im lokalen Verlauf korrekt nach Zeit.
        id: z.id,
        channel_id: z.channel_id,
        author_id: absenderUserId,
        content: new TextDecoder().decode(klartextBytes),
        nonce: null,
        created_at: new Date().toISOString()
      };
    } catch {
      // Entschluesseln fehlgeschlagen (fremde/kaputte Sitzung, korrupter
      // Umschlag) — NICHT quittieren, s. Modulkopf.
      return null;
    }
  });
}

async function postfachZyklus(): Promise<Message[]> {
  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) return [];

  const abholNutzlast = baueNutzlast('postfach-abholen');
  const abholSignatur = await signiereNutzlast(keypair, abholNutzlast);
  const zustellungen = await postfachApi.abholen({ cert: cert.raw, signatur: abholSignatur });
  if (zustellungen.length === 0) return [];

  const ident = await kryptoAccountLaden();
  const geoeffnet: Message[] = [];
  const quittierbar: string[] = [];
  // `verlaufSpeichern` nimmt einen Kanal je Aufruf — gleich beim Oeffnen nach
  // Kanal gruppieren, eine Abholung kann mehrere Gespraeche mitbringen.
  const nachKanal = new Map<string, Message[]>();

  for (const z of zustellungen) {
    const nachricht = await zustellungOeffnen(ident, z);
    if (!nachricht) continue;
    geoeffnet.push(nachricht);
    quittierbar.push(z.id);
    const liste = nachKanal.get(nachricht.channel_id);
    if (liste) liste.push(nachricht);
    else nachKanal.set(nachricht.channel_id, [nachricht]);
  }

  for (const [kanalId, liste] of nachKanal) {
    await verlaufSpeichern(kanalId, liste);
  }

  if (quittierbar.length > 0) {
    // ERST JETZT quittieren, s. Modulkopf.
    const quittungNutzlast = baueNutzlast('postfach-quittung', ...quittierbar);
    const quittungSignatur = await signiereNutzlast(keypair, quittungNutzlast);
    await postfachApi.quittieren({
      cert: cert.raw,
      signatur: quittungSignatur,
      zustellung_ids: quittierbar
    });
  }

  return geoeffnet;
}

/** Nur EIN Abholzyklus gleichzeitig (Bughunt 2026-08-28, FIX 3) —
 *  `postfach_neu` (`ws/handlers/chat.ts`) startet je Weckruf einen neuen
 *  Aufruf ohne eigene Wache; treffen mehrere kurz hintereinander ein, haengt
 *  sich jeder weitere nur an den bereits laufenden Zyklus an, statt
 *  denselben Bestand ein zweites Mal, unabhaengig, zu oeffnen. */
let laufenderZyklus: Promise<Message[]> | null = null;

/**
 * Holt alle offenen Zustellungen dieses Geraets ab, entschluesselt was sich
 * oeffnen laesst, legt es im lokalen Verlauf ab und quittiert erst danach.
 * Gibt die geoeffneten Nachrichten zurueck (fuer die sofortige Anzeige).
 */
export function postfachAbholenUndEntschluesseln(): Promise<Message[]> {
  if (!laufenderZyklus) {
    laufenderZyklus = postfachZyklus().finally(() => {
      laufenderZyklus = null;
    });
  }
  return laufenderZyklus;
}
