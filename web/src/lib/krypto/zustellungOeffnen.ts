/**
 * Oeffnet EINE Postfach-Zustellung — herausgeloest aus `empfangen.ts`, als
 * diese mit den Gruppen-Abzweigungen (Etappe G2) ueber die Groessen-Policy
 * (PLAN.md §12.1) gewachsen war. **Reiner Umzug, kein Verhalten geaendert.**
 *
 * Der Ablauf und seine Begruendungen stehen im Modulkopf von `empfangen.ts`
 * — dort steht auch der Zyklus, der diese Funktion je Zustellung ruft, und
 * die Reihenfolge Ablegen -> Quittieren, an der alles haengt. Hier nur die
 * Faelle, die diese Funktion selbst entscheidet:
 *
 * * schon lokal abgelegt -> `schonAbgelegt` (nur noch quittieren);
 * * Megolm-Gruppennachricht -> eigener Weg (`gruppe/empfangen.ts`);
 * * Olm-Umschlag -> Sitzung laden bzw. eingehend aufbauen, entschluesseln,
 *   sichern; enthaelt der Klartext einen Gruppen-Verteilschluessel, wird er
 *   dort abgelegt und die Zustellung ist `ohneAblage` quittierbar;
 * * alles Unlesbare -> `null`, die Zustellung bleibt liegen.
 */
import type { Message } from '../api/types';
import type { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { Umschlag } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { directMessages } from '../stores/directMessages.svelte';
import { verlaufSchonAbgelegt } from '../verlauf';
import type { PostfachZustellung } from '../api/postfach';
import {
  sitzungLaden,
  sitzungSichern,
  sitzungMitKontoAtomarSichern,
  mitSitzungssperre,
  partnerSchluesselMerken
} from './sitzungen';
import {
  leseNachrichtNutzlast,
  rahmenAusNutzlast
} from './nachrichtNutzlast';
import { baueEmpfangeneNachricht } from './empfangeneNachricht';
import { absenderErmitteln } from './absenderErmitteln';
import { oeffneMitRueckfall } from './sitzungsRueckfall';
import { PRIVATE_GRUPPEN_ENABLED } from './schalter';
import { ABLAGE_KANAL_ENABLED } from '../featureFlags';
import {
  istGruppennachricht,
  oeffneGruppennachricht,
  verteilschluesselAufnehmen
} from './gruppe/empfangen';

/**
 * Markiert, dass `sitzungMitKontoAtomarSichern` fuer eine Zustellung
 * fehlgeschlagen ist, NACHDEM `ident` bereits mutiert wurde (Bughunt
 * 2026-08-28, FIX 2, s. `empfangen.ts`-Modulkopf). Absichtlich eine eigene
 * Klasse statt eines rohen Fehlers: der Catch-Block unten muss sie von einem
 * gewoehnlichen Entschluesselungsfehler (unlesbarer Umschlag — dort bleibt
 * die Zustellung einfach liegen, der Zyklus laeuft normal weiter)
 * unterscheiden koennen.
 */
export class KontoSicherungFehlgeschlagen extends Error {}

/** Ergebnis eines Oeffnungsversuchs:
 *  * `neu` — frisch entschluesselte Nachricht, muss noch abgelegt werden;
 *  * `schonAbgelegt` — war schon einmal entschluesselt und abgelegt, braucht
 *    nur noch die (bislang fehlgeschlagene) Quittung (Bughunt-Runde 3,
 *    FIX 3, s. `empfangen.ts`-Modulkopf);
 *  * `ohneAblage` — erfolgreich verarbeitet, aber es gibt nichts anzuzeigen
 *    und nichts abzulegen: ein Gruppen-Verteilschluessel (Etappe G2, s.
 *    `gruppe/empfangen.ts`). Er ist in dem Moment sicher verwahrt, in dem
 *    seine eingehende Sitzung in IndexedDB liegt — die Quittung darf also
 *    direkt folgen.
 *
 *  `null`, wenn die Zustellung liegen bleiben muss. */
export type ZustellungOffenErgebnis =
  | { art: 'neu'; nachricht: Message }
  | { art: 'schonAbgelegt'; channelId: string; id: string }
  | { art: 'ohneAblage'; id: string }
  | { art: 'loeschung'; id: string; channelId: string; nachrichtId: string }
  /** Reaktions-Umschlag (P1.5): `ziel` ist die KANONISCHE ID der Nachricht,
   *  `autorId` der Sitzungs-Partner, der reagiert hat. Der Aufrufer wendet
   *  ihn lokal an und quittiert direkt — nichts abzulegen. */
  | {
      art: 'reaktion';
      id: string;
      channelId: string;
      autorId: string;
      ziel: string;
      emoji: string;
      entfernen: boolean;
    }
  | { art: 'bearbeitung'; id: string; channelId: string; ziel: string; inhalt: string }
  | null;

/** Die Nachricht einer erfolgreich geoeffneten Zustellung — `null`, wenn der
 *  Absender nicht ermittelbar ist: der Server liefert keinen
 *  `absender_user_id` (Sendegeraet zwischenzeitlich abgemeldet, s.
 *  `absenderErmitteln.ts`), UND der Kanal ist lokal (noch) nicht als
 *  Rueckfall bekannt (kann bei einer brandneuen DM knapp vor dem
 *  `ready`-Rahmen passieren; die naechste Abholung holt sie dann nach, s.
 *  `empfangen.ts`-Modulkopf „unlesbar"). */
export async function zustellungOeffnen(
  ident: Identitaet,
  z: PostfachZustellung
): Promise<ZustellungOffenErgebnis> {
  // FIX 3 (Bughunt-Runde 3) — ZUERST pruefen, noch vor jeder Sitzungssperre
  // und jedem Entschluesseln: liegt der Klartext schon lokal, braucht es
  // beides nicht mehr.
  if (await verlaufSchonAbgelegt(z.channel_id, z.id)) {
    return { art: 'schonAbgelegt', channelId: z.channel_id, id: z.id };
  }

  // Eine Megolm-Gruppennachricht (Etappe G2) laeuft ueber eine ganz andere
  // Sitzungsart und hat deshalb weder Sitzungssperre noch Absender-Rueckfall
  // gemeinsam mit dem Olm-Weg — sie wird hier abgezweigt, bevor irgendetwas
  // Olm-Spezifisches passiert. **Zwei Schalter, nicht einer:** private
  // Gruppen UND Ablage-Kanaele senden beide ueber `ART_GRUPPENNACHRICHT` (s.
  // `kanalSenden.ts`-Modulkopf, „identisch zu `sendeInGruppe`") — die
  // Zustellung selbst verraet nicht, welches Feature sie erzeugt hat. Steht
  // BEIDE Schalter aus, faellt sie durch auf `null` (liegen lassen); ist
  // auch nur einer an, kann eine solche Zustellung uebers jeweilige Feature
  // real entstanden sein und muss geoeffnet werden.
  if (istGruppennachricht(z)) {
    if (!PRIVATE_GRUPPEN_ENABLED && !ABLAGE_KANAL_ENABLED) return null;
    // Liefert NEBEN der Nachricht inzwischen auch Aktions-Frames
    // (Reaktion/Bearbeitung/Loeschung — dieselbe Erkennung wie im Olm-Weg
    // unten) direkt in der Ergebnis-Form dieses Zyklus, s.
    // `gruppe/empfangen.ts`.
    return oeffneGruppennachricht(z);
  }

  const absenderUserId = absenderErmitteln(
    z.absender_user_id,
    directMessages.byId[z.channel_id]?.other_user_id
  );
  if (!absenderUserId) return null;

  return mitSitzungssperre(z.channel_id, z.absender_device_pubkey, async () => {
    try {
      const vorhanden = await sitzungLaden(z.channel_id, z.absender_device_pubkey);
      // Sitzungsaufbau nur, wenn der Umschlag einer ist (Art 0) und der
      // Identitaetsschluessel mitkommt. Die Entscheidung "erst die alte
      // Sitzung, dann der Aufbau" steht in `sitzungsRueckfall.ts` — mit dem
      // Grund, warum es den Rueckfall geben MUSS.
      const aufbauen =
        z.art === 0 && z.absender_curve25519 !== null
          ? () => {
              const ergebnis = ident.sitzungEingehend(
                z.absender_curve25519 as string,
                new Umschlag(z.art, z.daten)
              );
              return { sitzung: ergebnis.sitzung(), klartext: ergebnis.klartext() };
            }
          : null;
      const geoeffnet = oeffneMitRueckfall(
        vorhanden,
        (sitzung) => sitzung.entschluesseln(new Umschlag(z.art, z.daten)),
        aufbauen
      );
      if (!geoeffnet) {
        // Laufende Nachricht ohne bekannte Sitzung, oder Sitzungsaufbau
        // ohne Identitaetsschluessel — nicht zu oeffnen, liegen lassen.
        console.warn('[postfach] Umschlag nicht zu öffnen: keine Sitzung', { art: z.art });
        return null;
      }
      const sitzung = geoeffnet.sitzung;
      const klartextBytes = geoeffnet.klartext;
      if (!geoeffnet.neu) {
        // Sichern VOR dem Quittieren — s. `empfangen.ts`-Modulkopf.
        await sitzungSichern(z.channel_id, z.absender_device_pubkey, sitzung);
      } else {
        // ATOMAR mit dem Konto sichern. Ab hier ist `ident` bereits mutiert
        // (der Einmalschluessel ist verbraucht); ein Fehlschlag hier darf NUR
        // diese eine Zustellung liegen lassen (FIX 2, Runde 3), darum ein
        // eigener, nicht-schluckbarer Fehlertyp statt des normalen "unlesbar
        // liegenlassen". Ersetzt eine alte Sitzung zum selben Geraet — die
        // hat gerade bewiesen, dass sie nicht mehr passt.
        try {
          await sitzungMitKontoAtomarSichern(
            ident,
            z.channel_id,
            z.absender_device_pubkey,
            sitzung
          );
        } catch (err) {
          throw new KontoSicherungFehlgeschlagen('Konto/Sitzung nicht sicherbar', { cause: err });
        }
        // Fuer wen die Sitzung gilt — damit `senden.ts` einen spaeteren
        // Schluesselwechsel der Gegenseite erkennt.
        await partnerSchluesselMerken(
          z.channel_id,
          z.absender_device_pubkey,
          z.absender_curve25519 as string
        );
      }

      if (
        (PRIVATE_GRUPPEN_ENABLED || ABLAGE_KANAL_ENABLED) &&
        (await verteilschluesselAufnehmen(z, klartextBytes))
      ) {
        return { art: 'ohneAblage', id: z.id };
      }

      // Autor-ID + Antwort-Kennung stehen (wenn vorhanden) in der Nutzlast
      // selbst, s. `nachrichtNutzlast.ts` — ein Klartext-Sender von vor
      // dieser Aenderung lieferte reinen, huellenlosen Text, den
      // `leseNachrichtNutzlast` als Legacy-Fall ohne beides erkennt. Die
      // Umsetzung in die Anzeige-Form teilt sich dieser Weg mit dem
      // Megolm-Weg, s. `empfangeneNachricht.ts`. Die Frame-Erkennung
      // (Loeschung/Reaktion/Bearbeitung) teilt er sich EBENFALLS mit dem
      // Megolm-Weg — dieselbe Funktion, dieselbe Bedeutung auf beiden Wegen.
      const gelesen = leseNachrichtNutzlast(klartextBytes);
      const rahmen = rahmenAusNutzlast(gelesen, z.id, z.channel_id, absenderUserId);
      if (rahmen) return rahmen;
      return { art: 'neu', nachricht: baueEmpfangeneNachricht(z, absenderUserId, gelesen) };
    } catch (err) {
      if (err instanceof KontoSicherungFehlgeschlagen) {
        // Weiterreichen, NICHT hier verschlucken — `postfachZyklus` laesst
        // NUR diese eine Zustellung liegen (FIX 2, Runde 3), sonst friert die
        // naechste erfolgreiche Zustellung den kompromittierten
        // Zwischenstand von `ident` ein.
        throw err;
      }
      // Entschluesseln fehlgeschlagen (fremde/kaputte Sitzung, korrupter
      // Umschlag) — NICHT quittieren, s. `empfangen.ts`-Modulkopf.
      //
      // Bis zum 2026-09-03 stand hier nur das `return null` — und eine
      // Zustellung, die nicht zu oeffnen war, verschwand ohne jede Spur:
      // kein Log, kein Zaehler, die Zeile blieb unquittiert liegen, und die
      // Gegenseite schickte weiter in eine Sitzung, die hier nie ankam.
      // Ohne Inhalt: der Fehlertext kommt aus dem Krypto-Kern, nie aus dem
      // Umschlag.
      console.warn('[postfach] Umschlag nicht zu öffnen', {
        art: z.art,
        fehler: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      });
      return null;
    }
  });
}
