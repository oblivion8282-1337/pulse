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
import { leseNachrichtNutzlast } from './nachrichtNutzlast';
import { baueEmpfangeneNachricht } from './empfangeneNachricht';
import { absenderErmitteln } from './absenderErmitteln';
import { oeffneMitRueckfall } from './sitzungsRueckfall';
import { absenderBinden } from './empfangsbindung';
import { PRIVATE_GRUPPEN_ENABLED } from './schalter';
import { ABLAGE_KANAL_ENABLED } from '../featureFlags';
import {
  istGruppennachricht,
  oeffneGruppennachricht,
  verteilschluesselAufnehmen
} from './gruppe/empfangen';
import { melde } from '../diagnose/app-diagnose';

/**
 * Zählt erfolglose Öffnungsversuche je Zustellung — dauerhaft, im
 * localStorage, damit ein App-Neustart den Zähler (und die Warnung) nicht
 * vergisst. Ohne den Zähler SPAMT eine dauerhaft unlesbare Zustellung
 * jeden Postfach-Zyklus: 20+ „Umschlag nicht zu öffnen" pro Minute waren
 * Michaels Konsolen-Log 2026-09-23, während der Umschlag 30 Tage liegen
 * bleibt (Server-Frist). Bewusst NICHT aufgeben/quittieren nach N Versuchen:
 * ob ein Umschlag jemals wieder öffnbar ist, entscheidet der Krypto-Kern,
 * nicht ein Zähler — aufgeben wäre Datenverlust nach Zeitplan.
 *
 * Deckel: 500 Einträge (die Server-Frist begrenzt die Lebensdauer ohnehin
 * auf 30 Tage, verwaiste lokale Einträge sind nur Bytes).
 */
const ZAEHLER_SPEICHER = 'pulse.postfach.unlesbar';
const ZAEHLER_DECKEL = 500;

function versuchZaehlen(id: string): number {
  try {
    const roh = localStorage.getItem(ZAEHLER_SPEICHER);
    const map = roh ? (JSON.parse(roh) as Record<string, number>) : {};
    map[id] = (map[id] ?? 0) + 1;
    const eintraege = Object.entries(map);
    if (eintraege.length > ZAEHLER_DECKEL) {
      // Älteste (kleinste Versuchszahl) kappen — grob, aber der Speicher
      // ist rein diagnostisch.
      eintraege.sort((a, b) => a[1] - b[1]);
      for (const [k] of eintraege.slice(0, eintraege.length - ZAEHLER_DECKEL)) delete map[k];
    }
    localStorage.setItem(ZAEHLER_SPEICHER, JSON.stringify(map));
    return map[id];
  } catch {
    // localStorage kann fehlen (Node-Test) oder voll sein — Zähler ist
    // Diagnostik, niemals Störgrund.
    return 1;
  }
}

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
  | {
      art: 'loeschung';
      id: string;
      channelId: string;
      nachrichtId: string;
      /** Wer den Frame geschickt hat — nur seine eigenen Sätze darf er löschen
       *  (s. `loeschZiel.ts`). */
      absenderUserId: string;
    }
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
    // 'verworfen' (Wiedereinspiel, fremde Absender-Angabe — s.
    // `gruppe/empfangen.ts`) ist erfolgreich BEHANDELT: quittieren, sonst
    // versucht der naechste Zyklus denselben Angriff wieder zu oeffnen.
    if (nachricht === 'verworfen') return { art: 'ohneAblage', id: z.id };
    return nachricht ? { art: 'neu', nachricht } : null;
  }

  const absenderUserId = absenderErmitteln(
    z.absender_user_id,
    directMessages.byId[z.channel_id]?.other_user_id
  );
  if (!absenderUserId) return null;

  // **Empfangs-Bindung (Bughunt 2026-09-23), VOR dem Rückfall-Block und
  // außerhalb der Sitzungssperre:** ein Aufbau-Umschlag (Art 0) baut die
  // Sitzung gegen die Metadaten-Kurve — die der Server frei setzt. Ohne
  // diese Prüfung liesse sich mit eigenem Prekey eine komplette Sitzung
  // „als die Gegenseite" fälschen (DM-Nachrichten wie Verteilschlüssel
  // gleichermaßen — beide reisen als Olm-Umschläge hier hindurch). Details
  // und die drei Ausgänge: `empfangsbindung.ts`. Läuft nur für Aufbau-
  // Umschläge, also einmal je Gerät und Sitzungsleben.
  let bindung: Awaited<ReturnType<typeof absenderBinden>> | null = null;
  if (z.art === 0 && z.absender_curve25519 !== null && z.absender_user_id !== null) {
    // Zweiter Bughunt-Lauf, Ergänzung: OHNE Metadaten-Konto keine Bindung —
    // `absenderErmitteln` fällt dann auf den Kanal-Gegenpart zurück, und für
    // eine Zustellung des EIGENEN anderen Geräts würde das Verzeichnis des
    // GEGNERS nach dem eigenen Gerät gefragt (nicht gefunden → legitime
    // Nachricht verworfen). Nur-Zeilen vor Migration 0076 tragen das leere
    // Feld und sterben an der Postfach-Frist; der Legacy-Weg bleibt für sie.
    bindung = await absenderBinden(
      absenderUserId,
      z.absender_device_pubkey,
      z.absender_curve25519
    );
    if (bindung.art === 'spaeter') return null; // Verzeichnis weg — liegen lassen, Retry im nächsten Zyklus
    if (bindung.art === 'zurueckgewiesen') return { art: 'ohneAblage', id: z.id };
  }

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
              // Die KURVE kommt aus der Verzeichnis-Bindung oben (verifiziert
              // gegen Bündel-Signatur + TOFU), nie aus den Metadaten. Der
              // Cast ist durch den identischen Gate oben gesichert: `bindung`
              // ist hier genau dann `geprueft`, wenn Art 0 und Kurve da sind.
              const geprueft = bindung as { art: 'geprueft'; curve25519: string };
              const ergebnis = ident.sitzungEingehend(
                geprueft.curve25519,
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
        // Einmal je Zustellung warnen + in den Kaefber-Ring (Zaehler s. o.,
        // Modulkopf) — dieser Fall ist das Symptom eines Absenders, der in
        // eine Sitzung schickt, die hier nie ankam, und gehoert in jeden
        // Diagnosebericht.
        const versuch = versuchZaehlen(`${z.id}`);
        if (versuch === 1) {
          console.warn('[postfach] Umschlag nicht zu öffnen: keine Sitzung', { art: z.art });
          melde('postfach', 'umschlag_ohne_sitzung', 'Umschlag ohne passende Sitzung', {
            art: z.art,
            kanal: z.channel_id
          });
        }
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
        // Schluesselwechsel der Gegenseite erkennt. Die VERIFIZIERTE Kurve
        // aus der Verzeichnis-Bindung, nicht die Metadaten-Angabe (identisch,
        // aber die Quelle ist die Zusicherung).
        await partnerSchluesselMerken(
          z.channel_id,
          z.absender_device_pubkey,
          (bindung as { art: 'geprueft'; curve25519: string }).curve25519
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
      // Megolm-Weg, s. `empfangeneNachricht.ts`.
      const gelesen = leseNachrichtNutzlast(klartextBytes);
      // **Absender-Bindung (Bughunt 2026-09-23):** die Nutzlast nennt ihr
      // Geraet; die Metadaten (`z.absender_device_pubkey`) setzt der Server
      // frei. Stimmen sie nicht, ist einer der beiden verdreht — genau die
      // Zuschreibungs-Faelschung, gegen die das Feld existiert. Verworfen
      // und quittierbar ('ohneAblage'), sonst bliebe sie fuer immer liegen
      // und wuerde jeden Abholzyklus erneut versuchen.
      if (gelesen.absenderGeraet !== null && gelesen.absenderGeraet !== z.absender_device_pubkey) {
        console.warn('[postfach] Nachricht mit fremder Absender-Angabe verworfen', {
          nutzlast: gelesen.absenderGeraet,
          zustellung: z.absender_device_pubkey
        });
        return { art: 'ohneAblage', id: z.id };
      }
      // **Zweiter Bughunt-Lauf (2026-09-23): dasselbe für das KONTO.** Der
      // Geräte-Check oben fängt den bösartigen Server — aber ein bösartiges
      // MITGLIED kann in seiner Nutzlast `absenderNutzer` auf ein fremdes
      // Konto setzen (eigenes Gerät = Metadaten passt!) und sich so eine
      // Zuschreibung erschreiben; schlimmer: einen Lösch-Frame mit fremder
      // Nutzer-ID, den `loeschZiel` als berechtigt einstuft. `absender_user_id`
      // füllt der Server aus dem Login — die Diskrepanz ist also immer eine
      // Fälschung. Nutzlasten ohne das Feld (Legacy) fallen durch zum Fallback.
      if (
        gelesen.absenderNutzer !== null &&
        z.absender_user_id !== null &&
        gelesen.absenderNutzer !== z.absender_user_id
      ) {
        console.warn('[postfach] Nachricht mit fremder Absender-Konto-Angabe verworfen', {
          nutzlast: gelesen.absenderNutzer,
          zustellung: z.absender_user_id
        });
        return { art: 'ohneAblage', id: z.id };
      }
      // Zuschreibung aus der authentisierten Nutzlast, wo vorhanden; erst
      // das Fehlen (Sender vor der Aenderung) faellt auf die Metadaten
      // und den DM-Rueckfall (`absenderErmitteln`) zurueck.
      const zuschreibung = gelesen.absenderNutzer ?? absenderUserId;
      if (gelesen.geloescht && gelesen.id !== null) {
        // Lösch-Frame (2026-09-02): der Aufrufer entfernt die Nachricht
        // lokal (Grabstein im Verlauf, damit auch im Archiv) und quittiert
        // direkt — es gibt nichts anzuzeigen und nichts abzulegen.
        return {
          art: 'loeschung',
          id: z.id,
          channelId: z.channel_id,
          nachrichtId: gelesen.id,
          absenderUserId: zuschreibung
        };
      }
      return { art: 'neu', nachricht: baueEmpfangeneNachricht(z, zuschreibung, gelesen) };
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
      //
      // 2026-09-23: gewarnt/berichtet wird nur der ERSTE Fehlversuch je
      // Zustellung (Zaehler oben) — der Postfach-Zyklus holt dieselbe
      // unlesbare Zeile sonst jeden Durchlauf erneut, und die Konsole
      // stand 20-fach voll, ohne dass eine neue Information dazukam. Der
      // erste Fehlversuch geht zusätzlich in den Kaefber-Ring: console.warn
      // wird dort nicht gefangen, und der Fehlertext (z. B.
      // `SitzungsaufbauFehlgeschlagen`) ist genau der Baustein, der die
      // Ursache im Feld sichtbar macht.
      const versuch = versuchZaehlen(`${z.id}`);
      if (versuch === 1) {
        const fehlerText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.warn('[postfach] Umschlag nicht zu öffnen', { art: z.art, fehler: fehlerText });
        melde('postfach', 'umschlag_unlesbar', `Umschlag nicht zu öffnen: ${fehlerText}`, {
          art: z.art,
          kanal: z.channel_id
        });
      }
      return null;
    }
  });
}
