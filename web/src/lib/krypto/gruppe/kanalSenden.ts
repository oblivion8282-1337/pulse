/**
 * Senden in einen Ablage-Kanal (Etappe E6) — derselbe Weg wie `senden.ts`
 * fuer private Gruppen, mit genau EINEM Unterschied: **wo die
 * Mitgliederliste herkommt.**
 *
 * Private Gruppen lesen sie vor JEDER Sendung frisch vom Server
 * (`gruppenApi.lesen`, kein Ereignis existiert). Ein Ablage-Kanal ist ein
 * Guild-Kanal — der hat WS-Ereignisse fuer Mitglieder-/Rechteaenderungen,
 * und `kanalSitzungswahl.ts` haengt sich daran statt vor jeder Nachricht zu
 * fragen: `mitgliederFuerNaechstesSenden` liefert entweder die im
 * `KanalSitzungState` gemerkte Liste (kein Ereignis seit der letzten
 * Sendung) oder holt frisch (`kanalMitgliederMitSicht`, `VIEW_CHANNEL` statt
 * `PrivateGroupMember`). Alles ab der Mitgliederliste — Geraete claimen,
 * Sitzung waehlen, verteilen, verschluesseln, einliefern, lokal ablegen —
 * ist identisch zu `sendeInGruppe`, s. dort fuer die volle Begruendung jedes
 * Schritts; hier stehen nur die Abweichungen.
 *
 * **`gruppensitzungLaden`/`gruppensitzungSichern` bleiben unveraendert.**
 * Ihr Speicher haengt nur an einer `kanalId`-Zeichenkette (s.
 * `gruppenSitzungen.ts`-Modulkopf) — ihr ist egal, ob sie zu einer privaten
 * Gruppe oder einem Guild-Kanal gehoert. Die MEGOLM-SITZUNG kommt deshalb
 * IMMER frisch aus IndexedDB, innerhalb der Gruppensitzungssperre — genau
 * wie bei `sendeInGruppe`, aus demselben Grund (Bughunt 2026-08-29, zwei
 * ueberlappende Sendungen duerften nie denselben Ratchet-Stand
 * verschluesseln). **`KanalSitzungState.stand` ist NICHT diese Quelle** —
 * er ist ein reiner Cache der zuletzt gesehenen MITGLIEDERLISTE (fuer
 * `mitgliederFuerNaechstesSenden`), gehalten vom Aufrufer (typischerweise
 * ein Eintrag je Kanal in einer Map, verdrahtet in Aufgabe 5/Chat-
 * Anbindung). Wer ihn stattdessen als Ersatz fuer `gruppensitzungLaden`
 * benutzte, baute pro Tab einen eigenen, unsynchronisierten Zwischenstand
 * der Megolm-Sitzung — derselbe Fehler, den die Sperre gerade verhindert.
 *
 * **`kanalStandUebernehmen` laeuft, sobald `sitzungWaehlen` einen Stand
 * geliefert hat** — nicht erst nach der Zustellung. Der neue Stand ist zu
 * diesem Zeitpunkt bereits nach `gruppensitzungSichern` (Schritt 6, vor
 * jedem Netzaufruf zur Zustellung) unterwegs; ein spaeterer Zustellfehler
 * aendert daran nichts mehr — die Mitgliederliste, mit der `sitzungWaehlen`
 * gerechnet hat, ist so oder so die aktuell gueltige. Bricht die Sendung
 * dagegen VOR `sitzungWaehlen` ab (Mitgliederliste/Geraete-Claim scheitert),
 * wird `kanalStandUebernehmen` nie erreicht — `ueberholt` bleibt wahr, der
 * naechste Versuch holt wieder frisch (s. `kanalSitzungswahl.ts`-Modulkopf).
 *
 * ## Warum die Zwillinge NICHT zu einer Funktion zusammengelegt sind
 *
 * Geprueft am 2026-09-01, und die Antwort ist bewusst „getrennt lassen".
 * Mechanisch ginge es: die rund sechzig Zeilen ab dem Verteilschritt sind
 * gleich, und die beiden Abweichungen (`ablage`, `kanalStandUebernehmen`)
 * liessen sich als optionales Argument bzw. als Aufruf VOR dem gemeinsamen
 * Teil unterbringen — es braeuchte nicht einmal einen Rueckruf.
 *
 * Dagegen steht die Eigenschaft, an der hier alles haengt: **dass die ganze
 * Spanne vom Laden der Sitzung bis zum letzten Sichern unter EINER Sperre
 * liegt, ist heute mit einem Blick auf eine Funktion nachpruefbar.** Wandert
 * die zweite Haelfte in eine dritte Datei, laesst sich derselbe Nachweis nur
 * noch fuehren, indem man dem Aufruf folgt und dort jede vorzeitige Rueckkehr
 * einzeln nachsieht. Das ist ein schlechterer Tausch als die vermiedene
 * Verdopplung: was hier durchrutscht, faellt nicht in einem Test auf, sondern
 * Wochen spaeter als Schluesselwiederverwendung.
 *
 * Der Preis der Trennung — dass eine Korrektur in `senden.ts` hier vergessen
 * werden kann — ist stattdessen dort ausgeschildert: der Modulkopf von
 * `senden.ts` nennt diesen Zwilling seit demselben Tag ausdruecklich. Die
 * Teile OHNE eigene Abweichung sind bereits gemeinsam
 * (`gruppenEinliefern.ts::verteilUmschlaege`/`bloeckeEinliefern`,
 * `gruppengeraete.ts`, `sitzungswahl.ts`, `lokaleNachrichtId.ts`) — dupliziert
 * ist nur noch die Reihenfolge selbst, und die ist genau das, was sichtbar
 * bleiben soll.
 */
import { keysApi } from '../../api/keys';
import type { PostfachNutzlast } from '../../api/postfach';
import { serversStore } from '../../api/servers.svelte';
import { auth } from '../../stores/auth.svelte';
import { verlaufSpeichernPflicht } from '../../verlauf';
import { verlaufZustand } from '../../verlauf/zustand.svelte';
import { parseMentionMarkers } from '../../components/mentionMarkierungen';
import { geraeteKennung } from '../geraeteKennung';
import { lokaleNachrichtId } from '../lokaleNachrichtId';
import { mitGruppensitzungssperre } from '../sperren';
import { baueNachrichtNutzlast } from '../nachrichtNutzlast';
import { ABLAGE_KANAL_ENABLED } from '../../featureFlags';
import type { Message } from '../../api/types';
import type { GruppenSendeErgebnis } from './senden';
import {
  type KanalSitzungState,
  mitgliederFuerNaechstesSenden,
  kanalStandUebernehmen,
  sitzungWaehlen,
  standNachSendung
} from './kanalSitzungswahl';
import { kanalMitgliederMitSicht } from './kanalMitglieder';
import { bloeckeEinliefern, verteilUmschlaege } from './gruppenEinliefern';
import { kanalLaufwerkSchluesselLaden } from '../../ablage/kanalLaufwerkSchluessel';
import { ART_GRUPPENNACHRICHT, baueGruppenhuelle, neueSitzungId } from './gruppenNutzlast';
import {
  gruppensitzungLaden,
  gruppensitzungSichern,
  neueGruppensitzung
} from './gruppenSitzungen';
import {
  gruppengeraeteBerechnen,
  inBloecke,
  inEmpfaengerBloecke,
  MAX_UMSCHLAEGE_JE_ANFRAGE
} from './gruppengeraete';

// Re-Export — `GruppenSendeErgebnis` ist derselbe Ergebnistyp wie bei
// privaten Gruppen, ein Aufrufer, der beide Wege verdrahtet, braucht nur
// einen Namen.
export type { GruppenSendeErgebnis };

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/**
 * Sendet `klartext` verschluesselt in den Ablage-Kanal `kanalId` (Teil der
 * Guild `guildId`). `state` haelt die Sitzungswahl-Buchhaltung dieses
 * Kanals (Mitgliederliste + Ueberholt-Markierung) — der Aufrufer legt ihn
 * einmal je Kanal an (`neuerKanalSitzungState`) und speist ihn mit
 * WS-Ereignissen (`kanalEreignisVerarbeiten`); beides ausserhalb dieser
 * Datei.
 */
export async function sendeInKanal(
  state: KanalSitzungState<ReturnType<typeof neueGruppensitzung>>,
  guildId: string,
  kanalId: string,
  klartext: string,
  replyToId: string | null = null
): Promise<GruppenSendeErgebnis> {
  // Der Riegel VOR dem ersten Serveraufruf — dieselbe Bauart wie
  // `sendeInGruppe`.
  if (!ABLAGE_KANAL_ENABLED) return { art: 'nicht_moeglich' };

  if (!auth.user) return { art: 'nicht_moeglich' };
  const eigeneUserId = auth.user.id;
  const eigeneKennung = await geraeteKennung();

  // Der einzige Unterschied zu `sendeInGruppe`, s. Modulkopf: ohne
  // Ereignis seit der letzten Sendung wird NICHT neu geholt.
  const mitgliederIds = await mitgliederFuerNaechstesSenden(state, () =>
    kanalMitgliederMitSicht(guildId, kanalId)
  );

  const buendel = await keysApi.claim(mitgliederIds, cloudRoute());
  const ziel = gruppengeraeteBerechnen(buendel, mitgliederIds, eigeneUserId, eigeneKennung);

  // Ab hier unter der Gruppensitzungssperre — Begruendung identisch zu
  // `sendeInGruppe` (Bughunt 2026-08-29): die ausgehende Megolm-Sitzung
  // liegt im BROWSERPROFIL, nicht im Tab, und wird deshalb IMMER frisch aus
  // IndexedDB geladen (nicht aus `state`, s. Modulkopf oben).
  return mitGruppensitzungssperre(kanalId, async () => {
    const wahl = sitzungWaehlen(
      await gruppensitzungLaden(kanalId),
      mitgliederIds,
      ziel.map((z) => z.geraet.device_pubkey),
      () => ({ sitzung: neueGruppensitzung(), sitzungId: neueSitzungId() }),
      Date.now()
    );
    const stand = wahl.stand;

    // Der Stand aus dieser Wahl ist ab jetzt gueltig, unabhaengig davon, ob
    // die Zustellung weiter unten gelingt — s. Modulkopf. Erst hier
    // uebernehmen: bricht der Aufruf VORHER ab (Mitgliederliste/Claim),
    // bleibt `state.ueberholt` wie es war.
    kanalStandUebernehmen(state, wahl);

    const nachzuliefern = new Set(wahl.nachzuliefern);
    // Kennt DIESES Geraet den Ablage-Hauptschluessel + die Freigabe-Adresse
    // (Kanal selbst verbunden ODER frueher ueber das Postfach empfangen —
    // beide Faelle landen im selben Speicher, s. `kanalLaufwerkSchluessel.ts`),
    // reist beides mit derselben Zustellung wie die Gruppensitzung mit
    // (Design §3.1). Kennt es sie nicht (gewoehnliches Mitgliedsgeraet, das
    // selbst noch nichts empfangen hat), bleibt `ablage` `undefined` — die
    // naechste Sendung eines Geraets, das sie kennt, liefert sie nach.
    const ablage = await kanalLaufwerkSchluesselLaden(kanalId);
    const schluesselUmschlaege = await verteilUmschlaege(
      kanalId,
      stand.sitzungId,
      stand.sitzung.verteilschluessel(),
      ziel.filter((z) => nachzuliefern.has(z.geraet.device_pubkey)),
      ablage ?? undefined
    );

    const nachrichtId = lokaleNachrichtId();
    const geheimtext = stand.sitzung.verschluesseln(
      baueNachrichtNutzlast(klartext, nachrichtId, replyToId)
    );
    const daten = baueGruppenhuelle(stand.sitzungId, geheimtext);
    const alleGeraete = ziel.map((z) => z.geraet.device_pubkey);

    const nachSendung = standNachSendung(stand, []);
    await gruppensitzungSichern(kanalId, nachSendung);

    if (alleGeraete.length === 0) {
      return { art: 'nicht_zugestellt' };
    }

    const { beliefert: schluesselBeliefert } = await bloeckeEinliefern(
      kanalId,
      eigeneKennung,
      inBloecke(schluesselUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)
    );
    const nachrichtUmschlaege: PostfachNutzlast[] = inEmpfaengerBloecke(alleGeraete).map(
      // Der Server legt ab, wenn der Kanal ein Ordner-Kanal ist; sonst
      // ignoriert er das Feld.
      (block) => ({ art: ART_GRUPPENNACHRICHT, daten, empfaenger: block, archiv: true })
    );
    const { beliefert: nachrichtBeliefert, letzterFehler: nachrichtFehler } =
      await bloeckeEinliefern(
        kanalId,
        eigeneKennung,
        inBloecke(nachrichtUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)
      );

    if (nachrichtBeliefert.size === 0) {
      if (nachrichtFehler) throw nachrichtFehler;
      return { art: 'nicht_zugestellt' };
    }

    if (schluesselBeliefert.size > 0) {
      await gruppensitzungSichern(kanalId, {
        ...nachSendung,
        beliefert: [...new Set([...nachSendung.beliefert, ...schluesselBeliefert])]
      });
    }

    const nachricht: Message = {
      id: nachrichtId,
      channel_id: kanalId,
      author_id: eigeneUserId,
      content: klartext,
      nonce: null,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      mentions: parseMentionMarkers(klartext),
      verschluesselt: true
    };
    try {
      await verlaufSpeichernPflicht(kanalId, [nachricht]);
    } catch (err) {
      verlaufZustand.melde(err);
    }
    return { art: 'gesendet', nachricht };
  });
}
