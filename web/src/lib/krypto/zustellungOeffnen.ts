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
  mitSitzungssperre
} from './sitzungen';
import { leseNachrichtNutzlast } from './nachrichtNutzlast';
import { baueEmpfangeneNachricht } from './empfangeneNachricht';
import { absenderErmitteln } from './absenderErmitteln';
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
    const nachricht = await oeffneGruppennachricht(z);
    return nachricht ? { art: 'neu', nachricht } : null;
  }

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
        // Sichern VOR dem Quittieren — s. `empfangen.ts`-Modulkopf.
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
        // ATOMAR mit dem Konto sichern. Ab hier ist `ident` bereits mutiert
        // (der Einmalschluessel ist verbraucht); ein Fehlschlag hier darf NUR
        // diese eine Zustellung liegen lassen (FIX 2, Runde 3), darum ein
        // eigener, nicht-schluckbarer Fehlertyp statt des normalen "unlesbar
        // liegenlassen".
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
      }

      // **VOR dem Nachrichten-Leser**: dieser Klartext koennte ein
      // Gruppen-Verteilschluessel sein (Etappe G2). `leseNachrichtNutzlast`
      // faellt bei allem ohne `text` auf den Legacy-Zweig zurueck und wuerde
      // den Schluessel als Nachrichtentext anzeigen UND im lokalen Verlauf
      // ablegen — die Reihenfolge ist deshalb keine Geschmacksfrage, s.
      // Modulkopf von `gruppe/gruppenNutzlast.ts` und der Test
      // `krypto-gruppe-nutzlast.test.ts::WARUM die Lesereihenfolge …`.
      // Derselbe Doppel-Schalter wie oben: ein Verteilschluessel kann von
      // einer privaten Gruppe ODER einem Ablage-Kanal stammen.
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
      // Megolm-Weg, s. `empfangeneNachricht.ts`.
      return {
        art: 'neu',
        nachricht: baueEmpfangeneNachricht(
          z,
          absenderUserId,
          leseNachrichtNutzlast(klartextBytes)
        )
      };
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
      return null;
    }
  });
}
