/**
 * Empfangen in einer privaten Gruppe (Etappe G2) — die zwei Dinge, die im
 * Postfach ankommen und nicht in den DM-Weg passen.
 *
 * **1. Ein Verteilschluessel.** Er kommt als gewoehnlicher Olm-Umschlag; erst
 * sein entschluesselter Klartext verraet, dass es keine Nachricht ist. Der
 * DM-Weg (`../empfangen.ts`) reicht ihn deshalb hierher, BEVOR er ihn dem
 * Nachrichten-Leser zeigt — die Reihenfolge ist eine Sicherheitsfrage, s.
 * Modulkopf von `gruppenNutzlast.ts`.
 *
 * **2. Eine Gruppennachricht** (Umschlagsart `ART_GRUPPENNACHRICHT`). Sie
 * wird ueber die eingehende Megolm-Sitzung geoeffnet, die der zugehoerige
 * Verteilschluessel angelegt hat.
 *
 * **Fehlt der Schluessel, bleibt die Zustellung liegen — sie haelt nichts
 * auf.** Genau wie ein unlesbarer Olm-Umschlag im DM-Weg: `null` zurueck,
 * NICHT quittiert, der Abholzyklus macht mit der naechsten weiter
 * (`postfachSchleife.ts::verarbeiteMitWiederherstellung` bricht nur bei
 * einem einzigen, ausdruecklich benannten Grund ab, und der ist hier nicht
 * erreichbar). Das Aushungern, gegen das jene Datei gebaut wurde, kann von
 * hier also nicht ausgehen.
 *
 * **Und dieser Fall repariert sich selbst.** Ein Schluessel gilt beim
 * Absender erst dann als verteilt, wenn der Server die Zustellung bestaetigt
 * hat (`senden.ts`, Schritt 8). Ging der Schluessel-Umschlag verloren,
 * waehrend die Gruppennachricht ankam, steht das Geraet beim Absender
 * weiterhin nicht in `beliefert` — seine naechste Sendung liefert den
 * Schluessel nach, und die liegengebliebene Nachricht laesst sich dann
 * oeffnen. Ohne die Reihenfolge in Schritt 8 waere sie dauerhaft verloren.
 */
import type { Message } from '../../api/types';
import type { PostfachZustellung } from '../../api/postfach';
import { leseNachrichtNutzlast } from '../nachrichtNutzlast';
import { baueEmpfangeneNachricht } from '../empfangeneNachricht';
import { ART_GRUPPENNACHRICHT, leseGruppenhuelle, leseVerteilNutzlast } from './gruppenNutzlast';
import {
  gruppenempfangLaden,
  gruppenempfangSichern,
  gruppenempfangAnlegenFallsNeu,
  gruppenWasserstandLesen,
  gruppenWasserstandMerken
} from './gruppenSitzungen';
import { wasserstandEntscheidung } from './wasserstand';
import { kanalLaufwerkSchluesselSichern } from '../../ablage/kanalLaufwerkSchluessel';

/** Ob diese Zustellung eine Megolm-Gruppennachricht ist. */
export function istGruppennachricht(z: PostfachZustellung): boolean {
  return z.art === ART_GRUPPENNACHRICHT;
}

/**
 * Nimmt einen entschluesselten Olm-Klartext entgegen und legt ihn als
 * eingehende Gruppensitzung ab, WENN es ein Verteilschluessel ist.
 *
 * Rueckgabe `true` heisst „war einer, ist abgelegt" — der Aufrufer darf die
 * Zustellung dann quittieren, ohne etwas in den Verlauf zu schreiben (es
 * gibt nichts anzuzeigen). `false` heisst „gewoehnliche Nachricht, mach
 * weiter wie bisher".
 *
 * **Der Kanal kommt aus der NUTZLAST, nicht aus der Zustellung.** Der
 * Verteilschluessel reist ueber die 1:1-Sitzung; deren Kanal ist der
 * DM-Kanal des Paares, nicht die Gruppe. Wer die Zustellung fragt, legt den
 * Schluessel unter dem falschen Kanal ab und findet ihn nie wieder.
 *
 * **Absender-Bindung (Bughunt 2026-09-23):** traegt die Nutzlast ihr
 * `absenderGeraet`, gilt das — nicht der Metadaten-Wert. Stimmen sie nicht
 * ueberein, behauptet der Server (der die Metadaten frei setzt), eine
 * fremde Sitzung sei von einem anderen Geraet: genau die
 * Zuschreibungs-Faelschung, gegen die das Feld existiert. Eine solche
 * Zustellung wird VERWORFEN (Rueckgabe `true`, quittierbar) — sie als
 * `false` durchfallen zu lassen, wuerde den Schluessel-JSON als
 * Chat-Nachricht ins Fenster stellen (s. Modulkopf von
 * `gruppenNutzlast.ts`). Nutzlasten ohne das Feld (Sender vor der
 * Aenderung) werden wie bisher unter dem Metadaten-Wert registriert.
 *
 * **Traegt die Nutzlast zusaetzlich einen Ablage-Hauptschluessel und eine
 * Freigabe-Adresse** (Design §3.1, nur bei Ablage-Kanaelen gesetzt), werden
 * beide unter demselben Kanal gesichert (`kanalLaufwerkSchluessel.ts`) —
 * NACH der Gruppensitzung, aber innerhalb desselben Aufrufs: beides gehoert
 * zusammen zu genau dieser Zustellung, ein Zwischenzustand mit nur einem
 * der beiden waere kein Fehler (der naechste Verteilschluessel traegt
 * ohnehin wieder beide), aber unnoetig. */
export async function verteilschluesselAufnehmen(
  z: PostfachZustellung,
  klartextBytes: Uint8Array
): Promise<boolean> {
  const gelesen = leseVerteilNutzlast(klartextBytes);
  if (!gelesen) return false;
  if (gelesen.absenderGeraet !== undefined && gelesen.absenderGeraet !== z.absender_device_pubkey) {
    console.warn('[gruppe] Verteilschluessel mit fremder Absender-Angabe verworfen', {
      nutzlast: gelesen.absenderGeraet,
      zustellung: z.absender_device_pubkey
    });
    return true; // verworfen, quittierbar — NIE `false` (s. oben)
  }
  await gruppenempfangAnlegenFallsNeu(
    gelesen.kanal,
    gelesen.absenderGeraet ?? z.absender_device_pubkey,
    gelesen.sitzung,
    gelesen.schluessel
  );
  if (gelesen.ablageHauptschluessel && gelesen.freigabeAdresse) {
    await kanalLaufwerkSchluesselSichern(
      gelesen.kanal,
      gelesen.ablageHauptschluessel,
      gelesen.freigabeAdresse
    );
  }
  return true;
}

/**
 * Oeffnet eine Gruppennachricht.
 *
 * Rueckgabe:
 *  * `Message` — frisch entschluesselt, abzulegen und anzuzeigen;
 *  * `'verworfen'` — erfolgreich GEBEHANDELT, aber absichtlich nichts
 *    anzuzeigen (Wiedereinspiel, fremde Absender-Angabe): die Zustellung
 *    wird quittiert, sonst wuerde sie jeden Abholzyklus erneut versuchen;
 *  * `null` — liegen bleiben muss sie (unlesbare Huelle, unbekannte
 *    Sitzung, fehlender Absender).
 *
 * **Kein Rueckfall auf „der andere Kanal-Teilnehmer" beim Absender.** Im
 * DM-Weg gibt es den (`absenderErmitteln.ts`), weil ein DM-Kanal genau zwei
 * Konten hat. Eine Gruppe hat viele — dort waere jede Vermutung eine falsche
 * Zuschreibung, und eine falsch zugeschriebene Nachricht ist schlimmer als
 * eine, die einen Zyklus spaeter kommt.
 *
 * **Wiedereinspiel-Schutz (Bughunt 2026-09-23):** der Megolm-Zaehler jeder
 * geoeffneten Nachricht wird je Sitzung als Wasserstand gemerkt; ein
 * Geheimtext auf oder unter dem Stand unter NEUER Zustellungs-ID ist ein
 * Wiedereinspiel (der Server war es, der Zustellungs-IDs vergibt) und wird
 * verworfen. Dieselbe ID heisst eigene Wiederholung (Absturz-Fenster
 * zwischen Oeffnen und Ablegen) und wird gefahrlos erneut geoeffnet — s.
 * `wasserstand.ts`.
 *
 * **Zuschreibung aus der NUTZLAST** (`absenderNutzer`), sobald sie sie
 * traegt: die Metadaten setzt der Server frei, die Nutzlast ist gegen die
 * Megolm-Sitzung authentisiert. Erst der fehlende Wert (Sender vor der
 * Aenderung) faellt auf die Metadaten zurueck — deshalb bleibt die
 * `absender_user_id === null`-Sperre bestehen.
 */
export async function oeffneGruppennachricht(
  z: PostfachZustellung
): Promise<Message | 'verworfen' | null> {
  const huelle = leseGruppenhuelle(z.daten);
  if (!huelle || z.absender_user_id === null) return null;

  const empfang = await gruppenempfangLaden(
    z.channel_id,
    z.absender_device_pubkey,
    huelle.sitzung
  );
  if (!empfang) return null;

  let geoeffnet: { klartext(): Uint8Array; zaehler(): number };
  try {
    geoeffnet = empfang.entschluesseln(huelle.nachricht);
  } catch {
    // Kaputter Geheimtext oder eine Sitzung, die ueber diese Nachricht
    // hinaus ist — liegen lassen, nicht quittieren.
    return null;
  }

  const stand = await gruppenWasserstandLesen(
    z.channel_id,
    z.absender_device_pubkey,
    huelle.sitzung
  );
  const entscheidung = wasserstandEntscheidung(stand, geoeffnet.zaehler(), z.id);
  if (entscheidung === 'wiedereinspiel') {
    console.warn('[gruppe] Wiedereinspiel abgewiesen', {
      sitzung: huelle.sitzung,
      zaehler: geoeffnet.zaehler(),
      wasserstand: stand?.zaehler
    });
    return 'verworfen';
  }

  const gelesen = leseNachrichtNutzlast(geoeffnet.klartext());
  if (
    gelesen.absenderGeraet !== null &&
    gelesen.absenderGeraet !== z.absender_device_pubkey
  ) {
    // Die Nutzlast sagt ein anderes Geraet als die Zustellung — der Server
    // hat einen der beiden Werte verdreht (s. oben). Verwerfen, nicht
    // anzeigen; falsche Zuschreibung waere schlimmer als eine Luecke.
    console.warn('[gruppe] Gruppennachricht mit fremder Absender-Angabe verworfen', {
      nutzlast: gelesen.absenderGeraet,
      zustellung: z.absender_device_pubkey
    });
    return 'verworfen';
  }
  if (
    gelesen.absenderNutzer !== null &&
    z.absender_user_id !== null &&
    gelesen.absenderNutzer !== z.absender_user_id
  ) {
    // Zweiter Bughunt-Lauf (2026-09-23): dasselbe für das KONTO. Ein
    // bösartiges MITGLIED (nicht nur der Server) kann in seiner eigenen
    // Nutzlast `absenderNutzer` auf ein fremdes Konto setzen — der
    // Geräte-Check passt dann (eigenes Gerät), die Nachricht erschiene als
    // fremde Worte, und ein Lösch-Frame würde fremde Nachrichten
    // löschen (`loeschZiel` vertraut der Zuschreibung). `absender_user_id`
    // füllt der Server aus dem Login — Diskrepanz = Fälschung.
    console.warn('[gruppe] Gruppennachricht mit fremder Absender-Konto-Angabe verworfen', {
      nutzlast: gelesen.absenderNutzer,
      zustellung: z.absender_user_id
    });
    return 'verworfen';
  }

  // Sichern VOR der Quittung — der Ratchet ist weitergedreht. Der
  // Wasserstand wandert mit: erst nach beiden ist die Nachricht „gesehen".
  await gruppenempfangSichern(z.channel_id, z.absender_device_pubkey, huelle.sitzung, empfang);
  if (entscheidung === 'ok') {
    await gruppenWasserstandMerken(
      z.channel_id,
      z.absender_device_pubkey,
      huelle.sitzung,
      {
        zaehler: geoeffnet.zaehler(),
        zustellung: z.id
      }
    );
  }

  // Dieselbe Umsetzung in die Anzeige-Form wie im Olm-Weg, s.
  // `../empfangeneNachricht.ts` — dort stehen auch die Gruende fuer die
  // ID-Wahl und die beiden bedingten Felder. Die Zuschreibung kommt aus der
  // authentisierten Nutzlast, wo sie vorhanden ist (s. oben).
  const absenderUserId = gelesen.absenderNutzer ?? z.absender_user_id;
  return baueEmpfangeneNachricht(z, absenderUserId, gelesen);
}
