/**
 * Aktions-Frames (Loeschung, Reaktion, Bearbeitung) in eine verschluesselte
 * private Gruppe — derselbe Weg wie `senden.ts::sendeInGruppe`, mit genau
 * einem inhaltlichen Unterschied: **was verschluesselt wird.** Statt einer
 * Nachricht (`baueNachrichtNutzlast`) faehrt ein FRAME
 * (`../nachrichtNutzlast.ts`: `geloescht`/`reaktion`/`bearbeitung`, FASSUNG
 * 1) im Megolm-Geheimtext — dadurch erreicht er JEDES Mitglieder-Geraet
 * inklusive der eigenen anderen, ueber dieselbe verteilte Sitzung wie jede
 * andere Gruppen-Nachricht. Der DM-Weg (`../senden.ts::versendeFrame`) passt
 * hier nicht: er adressiert die Geraete EINER Gegenstelle per Olm-Paarung.
 *
 * Der zweite Unterschied ist die Abwesenheit von Schritt 9: **ein Frame ist
 * keine Nachricht** — nichts liegt lokal im Verlauf, der Aufrufer
 * (`chat/cloudNachrichtAktionen.ts`) vollzieht die Aktion lokal selbst voll
 * und braucht nur ein Ja/Nein. Deshalb auch eine eigene Funktion statt eines
 * Parameters an `sendeInGruppe`: die haette ihr `Message`-Ergebnis, ihre
 * lokale Ablage und ihre Erwaehnungs-Parsung an einen Frame verloren.
 *
 * Die Schritte 1-8 stehen begruendet im Modulkopf von `senden.ts` —
 * Mitgliederliste frisch, Geraete claimen, Sitzung waehlen, Schluessel
 * nachliefern, verschluesseln, sichern VOR dem Einliefern, `beliefert` erst
 * nach der Zustellung nachtragen. **Wer hier an der Reihenfolge etwas
 * aendert, aendert es dort mit** (dieselbe Auschilderung wie zwischen
 * `senden.ts` und `kanalSenden.ts`; die Sperrspanne ist auch hier mit einem
 * Blick auf EINE Funktion nachpruefbar).
 *
 * Ein Frame verbraucht eine Megolm-Ratchet-Stufe und zaehlt deshalb in
 * `standNachSendung` als Nachricht — sonst driftete der Zaehler vom echten
 * Ratchet-Stand davon und die Sitzung rotierte spaeter, als verschluesselt
 * wurde.
 */
import { keysApi } from '../../api/keys';
import { gruppenApi } from '../../api/gruppen';
import type { PostfachNutzlast } from '../../api/postfach';
import { serversStore } from '../../api/servers.svelte';
import { auth } from '../../stores/auth.svelte';
import { geraeteKennung } from '../geraeteKennung';
import { mitGruppensitzungssperre } from '../sperren';
import {
  baueBearbeitungsNutzlast,
  baueLoeschNutzlast,
  baueReaktionsNutzlast
} from '../nachrichtNutzlast';
import { PRIVATE_GRUPPEN_ENABLED } from '../schalter';
import { sitzungWaehlen, standNachSendung } from './sitzungswahl';
import { bloeckeEinliefern, verteilUmschlaege } from './gruppenEinliefern';
import { ART_GRUPPENNACHRICHT, baueGruppenhuelle, neueSitzungId } from './gruppenNutzlast';
import { gruppensitzungLaden, gruppensitzungSichern, neueGruppensitzung } from './gruppenSitzungen';
import { gruppengeraeteBerechnen, inBloecke, inEmpfaengerBloecke, MAX_UMSCHLAEGE_JE_ANFRAGE } from './gruppengeraete';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Verschluesselt den Frame EINMAL mit der Gruppen-Sitzung und liefert ihn an
 * alle Mitglieder-Geraete ein. `true` nur bei nachgewiesener Zustellung;
 * Netz- oder Serverfehler werden geworfen, nicht verschluckt — der Aufrufer
 * zeigt sie an (dieselbe Regel wie beim DM-Frame).
 */
async function versendeGruppenFrame(
  kanalId: string,
  klartextBytes: Uint8Array
): Promise<boolean> {
  // Der Riegel VOR dem ersten Serveraufruf — wie in `sendeInGruppe`.
  if (!PRIVATE_GRUPPEN_ENABLED) return false;
  if (!auth.user) return false;
  const eigeneUserId = auth.user.id;
  const eigeneKennung = await geraeteKennung();

  // Schritt 1 — Mitgliederliste frisch vom Server, dieselbe Aussperrungs-
  // Logik wie bei jeder Gruppen-Nachricht.
  const gruppe = await gruppenApi.lesen(kanalId);
  if (!gruppe) return false;
  const mitgliederIds = gruppe.members.map((m) => m.user_id);

  // Schritt 2.
  const buendel = await keysApi.claim(mitgliederIds, cloudRoute());
  const ziel = gruppengeraeteBerechnen(buendel, mitgliederIds, eigeneUserId, eigeneKennung);

  // Schritte 3-8 unter derselben Sperre mit demselben Zuschnitt — s. Modulkopf.
  return mitGruppensitzungssperre(kanalId, async () => {
    const wahl = sitzungWaehlen(
      await gruppensitzungLaden(kanalId),
      mitgliederIds,
      ziel.map((z) => z.geraet.device_pubkey),
      () => ({ sitzung: neueGruppensitzung(), sitzungId: neueSitzungId() }),
      Date.now()
    );
    const stand = wahl.stand;

    const nachzuliefern = new Set(wahl.nachzuliefern);
    const schluesselUmschlaege = await verteilUmschlaege(
      kanalId,
      stand.sitzungId,
      stand.sitzung.verteilschluessel(),
      ziel.filter((z) => nachzuliefern.has(z.geraet.device_pubkey))
    );

    const geheimtext = stand.sitzung.verschluesseln(klartextBytes);
    const daten = baueGruppenhuelle(stand.sitzungId, geheimtext);
    const alleGeraete = ziel.map((z) => z.geraet.device_pubkey);

    const nachSendung = standNachSendung(stand, []);
    await gruppensitzungSichern(kanalId, nachSendung);

    if (alleGeraete.length === 0) {
      // Kein Mitglied hat ein veroeffentlichtes Geraet — niemand zu stellen.
      return false;
    }

    // Schluessel ZUERST, dann der Frame — dieselbe Reihenfolge wie in
    // `sendeInGruppe`, damit ein Empfaenger den Schluessel in der Hand hat,
    // bevor die Nachricht kommt.
    const { beliefert: schluesselBeliefert } = await bloeckeEinliefern(
      kanalId,
      eigeneKennung,
      inBloecke(schluesselUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)
    );
    const frameUmschlaege: PostfachNutzlast[] = inEmpfaengerBloecke(alleGeraete).map(
      (block) => ({ art: ART_GRUPPENNACHRICHT, daten, empfaenger: block })
    );
    const { beliefert: frameBeliefert, letzterFehler } = await bloeckeEinliefern(
      kanalId,
      eigeneKennung,
      inBloecke(frameUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)
    );

    if (frameBeliefert.size === 0) {
      if (letzterFehler) throw letzterFehler;
      return false;
    }
    if (schluesselBeliefert.size > 0) {
      await gruppensitzungSichern(kanalId, {
        ...nachSendung,
        beliefert: [...new Set([...nachSendung.beliefert, ...schluesselBeliefert])]
      });
    }
    return true;
  });
}

/**
 * Loescht eine verschluesselte Gruppen-Nachricht: Loesch-Frame an alle
 * Mitglieder-Geraete. `true` nur bei Zustellung; den lokalen Grabstein setzt
 * der Aufrufer unabhaengig davon.
 */
export function sendeGruppenLoeschung(kanalId: string, nachrichtId: string): Promise<boolean> {
  return versendeGruppenFrame(kanalId, baueLoeschNutzlast(nachrichtId));
}

/**
 * Reagiert auf eine verschluesselte Gruppen-Nachricht. `zielNachrichtId`
 * MUSS die KANONISCHE Form sein (`kanonischeAntwortId.ts` — dieselbe lokale
 * ID sieht je Geraet anders aus). `true` nur bei Zustellung; der Aufrufer
 * wendet die Reaktion erst DANN lokal an.
 */
export function sendeGruppenReaktion(
  kanalId: string,
  zielNachrichtId: string,
  emoji: string,
  entfernen: boolean
): Promise<boolean> {
  return versendeGruppenFrame(kanalId, baueReaktionsNutzlast(zielNachrichtId, emoji, entfernen));
}

/**
 * Bearbeitet eine verschluesselte Gruppen-Nachricht: Bearbeitungs-Frame an
 * alle Mitglieder-Geraete. `zielNachrichtId` MUSS die KANONISCHE Form sein.
 */
export function sendeGruppenBearbeitung(
  kanalId: string,
  zielNachrichtId: string,
  inhalt: string
): Promise<boolean> {
  return versendeGruppenFrame(kanalId, baueBearbeitungsNutzlast(zielNachrichtId, inhalt));
}
