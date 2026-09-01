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
import { parseMentionMarkers } from '../../components/mentionMarkierungen';
import { leseNachrichtNutzlast } from '../nachrichtNutzlast';
import { anhangAngabeZuAttachment } from '../anhangAnzeige';
import { ART_GRUPPENNACHRICHT, leseGruppenhuelle, leseVerteilNutzlast } from './gruppenNutzlast';
import {
  gruppenempfangLaden,
  gruppenempfangSichern,
  gruppenempfangAnlegenFallsNeu
} from './gruppenSitzungen';
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
  await gruppenempfangAnlegenFallsNeu(
    gelesen.kanal,
    z.absender_device_pubkey,
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
 * Oeffnet eine Gruppennachricht. `null`, wenn sie liegen bleiben muss:
 * unlesbare Huelle, unbekannte Sitzung (Schluessel noch nicht da), oder der
 * Absender ist nicht zu ermitteln.
 *
 * **Kein Rueckfall auf „der andere Kanal-Teilnehmer" beim Absender.** Im
 * DM-Weg gibt es den (`absenderErmitteln.ts`), weil ein DM-Kanal genau zwei
 * Konten hat. Eine Gruppe hat viele — dort waere jede Vermutung eine falsche
 * Zuschreibung, und eine falsch zugeschriebene Nachricht ist schlimmer als
 * eine, die einen Zyklus spaeter kommt. Fehlt `absender_user_id` (das
 * Sendegeraet hat sich zwischen Einliefern und Abholen abgemeldet), bleibt
 * die Zustellung liegen.
 */
export async function oeffneGruppennachricht(
  z: PostfachZustellung
): Promise<Message | null> {
  const huelle = leseGruppenhuelle(z.daten);
  if (!huelle || z.absender_user_id === null) return null;

  const empfang = await gruppenempfangLaden(
    z.channel_id,
    z.absender_device_pubkey,
    huelle.sitzung
  );
  if (!empfang) return null;

  let klartextBytes: Uint8Array;
  try {
    klartextBytes = empfang.entschluesseln(huelle.nachricht).klartext();
  } catch {
    // Kaputter Geheimtext oder eine Sitzung, die ueber diese Nachricht
    // hinaus ist — liegen lassen, nicht quittieren.
    return null;
  }
  // Sichern VOR der Quittung — der Ratchet ist weitergedreht.
  await gruppenempfangSichern(z.channel_id, z.absender_device_pubkey, huelle.sitzung, empfang);

  const { text, id: kanonischeId, replyToId, anhaenge } = leseNachrichtNutzlast(klartextBytes);
  return {
    id: z.id,
    channel_id: z.channel_id,
    author_id: z.absender_user_id,
    content: text,
    nonce: null,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    mentions: parseMentionMarkers(text),
    verschluesselt: true,
    ...(kanonischeId !== null ? { krypto_id: kanonischeId } : {}),
    ...(anhaenge.length > 0
      ? { attachments: anhaenge.map(anhangAngabeZuAttachment) }
      : {})
  };
}
