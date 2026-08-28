/**
 * Senden in einen privaten Gruppenkanal (Etappe G2).
 *
 * Ablauf, und die Reihenfolge ist an drei Stellen zwingend:
 *
 *  1. **Mitgliederliste FRISCH vom Server** (`GET /gruppen/{id}`). Nicht aus
 *     einem Speicher — daran haengt die Aussperrung, s.
 *     `sitzungswahl.ts`-Modulkopf. Es gibt kein Ereignis ueber einen
 *     Mitgliederwechsel (nachgesehen), dieser Aufruf IST die Erkennung.
 *  2. Geraete aller Mitglieder holen (`POST /keys/claim` — verbraucht je
 *     Buendel einen Einmalschluessel, deshalb nicht oefter als noetig).
 *  3. **Sitzung waehlen** (`sitzungWaehlen`): weiterlaufen lassen oder
 *     wegwerfen. Ein Mitgliederwechsel heisst: neue Sitzung.
 *  4. Verteilschluessel an jedes noch nicht belieferte Geraet — je ein
 *     Olm-Umschlag ueber die 1:1-Sitzung, wie eine gewoehnliche DM. Das ist
 *     der Preis, den Megolm EINMAL je Sitzung zahlt statt einmal je
 *     Nachricht.
 *  5. Die Nachricht EINMAL mit Megolm verschluesseln.
 *  6. **Gruppensitzung sichern, VOR dem Einliefern** — der Ratchet ist schon
 *     weitergedreht; ein Absturz danach darf den neuen Stand nicht verlieren.
 *     Dieselbe Regel wie bei Olm (`../sitzungen.ts`-Modulkopf).
 *  7. Einliefern. Erst die Schluessel-Umschlaege aus Schritt 4, dann die
 *     Nachricht — EIN Geheimtext (Art `ART_GRUPPENNACHRICHT`) mit allen
 *     Geraeten als Empfaenger. Beides wird an zwei verschiedenen
 *     Server-Grenzen aufgeteilt (Empfaenger je Nutzlast, Umschlaege je
 *     Anfrage), s. `gruppengeraete.ts` und Schritt 7 unten.
 *  8. **Erst nach erfolgreicher Zustellung** nachtragen, WER den Schluessel
 *     jetzt hat. Vorher waere es eine Behauptung: schlaegt das Einliefern
 *     fehl, haetten die Geraete den Schluessel nie bekommen, wuerden aber
 *     beim naechsten Mal als „beliefert" uebersprungen — und koennten ab
 *     dann nichts mehr lesen, dauerhaft und ohne Fehlermeldung.
 *  9. Lokal ablegen. Der Server sieht den Klartext nie; es gibt keine zweite
 *     Kopie.
 *
 * **Kein Klartext-Rueckfall.** Anders als bei DMs (`../senden.ts`) gibt es
 * fuer Gruppen keinen unverschluesselten Weg — sie sind von Geburt an
 * verschluesselt (Spec §9). Scheitert etwas, ist die Nachricht NICHT
 * gesendet, und der Aufrufer muss das sichtbar machen.
 */
import type { Message } from '../../api/types';
import { certStore } from '../../identity/cert.svelte';
import { loadKeypair, type WebCryptoKeypair } from '../../identity/keypair.svelte';
import { keysApi } from '../../api/keys';
import { gruppenApi } from '../../api/gruppen';
import { postfachApi, type PostfachNutzlast } from '../../api/postfach';
import { serversStore } from '../../api/servers.svelte';
import { verlaufSpeichernPflicht } from '../../verlauf';
import { verlaufZustand } from '../../verlauf/zustand.svelte';
import { parseMentionMarkers } from '../../components/mentionMarkierungen';
import { kryptoAccountLaden } from '../account.svelte';
import { sitzungLaden, sitzungSichern, mitSitzungssperre } from '../sitzungen';
import { baueNutzlast } from '../nutzlast';
import { baueNachrichtNutzlast } from '../nachrichtNutzlast';
import { signiereNutzlast } from '../nachweis';
import { PRIVATE_GRUPPEN_ENABLED } from '../schalter';
import { sitzungWaehlen, standNachSendung } from './sitzungswahl';
import {
  ART_GRUPPENNACHRICHT,
  baueVerteilNutzlast,
  baueGruppenhuelle,
  neueSitzungId
} from './gruppenNutzlast';
import {
  gruppensitzungLaden,
  gruppensitzungSichern,
  neueGruppensitzung
} from './gruppenSitzungen';
import {
  gruppengeraeteBerechnen,
  inBloecke,
  inEmpfaengerBloecke,
  MAX_UMSCHLAEGE_JE_ANFRAGE,
  type Gruppenzielgeraet
} from './gruppengeraete';

export type GruppenSendeErgebnis =
  | { art: 'gesendet'; nachricht: Message }
  /** Schalter aus, kein Nachweis moeglich, oder die Gruppe gibt es nicht
   *  (mehr) — es wurde NICHTS unternommen. */
  | { art: 'nicht_moeglich' }
  /** Es wurde verschluesselt und eingeliefert, aber nirgends entstand eine
   *  Zustellung (kein Mitglied hat ein veroeffentlichtes Geraet). */
  | { art: 'nicht_zugestellt' };

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Rein lokale Nachrichten-ID, identisch gebaut wie im DM-Weg
 *  (`../senden.ts::lokaleNachrichtId`) — der Server sieht diese Nachricht
 *  nie und kann ihr keine Snowflake zuteilen. */
function lokaleNachrichtId(): string {
  const zeit = Date.now().toString().padStart(13, '0');
  const zufall = Math.floor(Math.random() * 1e7)
    .toString()
    .padStart(7, '0');
  return zeit + zufall;
}

/** Baut je Zielgeraet einen Olm-Umschlag mit dem Verteilschluessel. Geraete
 *  ohne verwertbaren Schluessel werden uebersprungen — sie bekommen ihn beim
 *  naechsten Mal, weil sie dann immer noch nicht in `beliefert` stehen. */
async function verteilUmschlaege(
  kanalId: string,
  sitzungId: string,
  verteilschluessel: string,
  ziel: Gruppenzielgeraet[]
): Promise<{ nutzlasten: PostfachNutzlast[]; beliefert: string[] }> {
  const ident = await kryptoAccountLaden();
  const klartext = baueVerteilNutzlast(kanalId, sitzungId, verteilschluessel);
  const nutzlasten: PostfachNutzlast[] = [];
  const beliefert: string[] = [];
  for (const { geraet } of ziel) {
    const umschlag = await mitSitzungssperre(kanalId, geraet.device_pubkey, async () => {
      let sitzung = await sitzungLaden(kanalId, geraet.device_pubkey);
      if (!sitzung) {
        const einmal = geraet.einmalschluessel ?? geraet.rueckfallschluessel;
        if (!einmal) return null;
        sitzung = ident.sitzungAusgehend(geraet.curve25519, einmal);
      }
      const gebaut = sitzung.verschluesseln(klartext);
      // Sichern VOR dem Einliefern — s. `../sitzungen.ts`-Modulkopf.
      await sitzungSichern(kanalId, geraet.device_pubkey, sitzung);
      return gebaut;
    });
    if (!umschlag) continue;
    nutzlasten.push({
      art: umschlag.art(),
      daten: umschlag.daten(),
      empfaenger: [geraet.device_pubkey]
    });
    beliefert.push(geraet.device_pubkey);
  }
  return { nutzlasten, beliefert };
}

/**
 * Eine einzelne Einlieferung. Gibt die Geraete-Pubkeys zurueck, die der
 * Server uebersprungen hat (unbekanntes Buendel, Kontingent voll) — bei
 * einem koerperlosen 2xx eine leere Liste, denn dann hat er nichts
 * uebersprungen GESAGT, und ohne Gegenbeweis gilt zugestellt (dieselbe
 * Deutung wie `wurdeZugestellt`, s. `../zustellErgebnis.ts`).
 *
 * **Die Unterschrift bindet genau die Umschlaege DIESER Anfrage** — der
 * Server baut die Bytes aus dem Rumpf nach (`routes/postfach.py`, Schritt 2).
 * Eine ueber alle Bloecke gemeinsam geleistete Unterschrift passte zu keinem
 * einzelnen Rumpf.
 *
 * **Wirft absichtlich weiter.** Der DM-Weg faengt hier einen 404 ab und
 * faellt auf den Klartext zurueck (`../zustellErgebnis.ts`) — fuer eine
 * Gruppe gibt es diesen Weg nicht, ein verschluckter Fehler waere eine
 * Nachricht, die niemand bekommen hat und die niemand vermisst.
 */
async function einliefernEinmal(
  kanalId: string,
  certRoh: string,
  keypair: WebCryptoKeypair,
  nutzlasten: PostfachNutzlast[]
): Promise<string[]> {
  const bytes = baueNutzlast('postfach', kanalId, ...nutzlasten.map((n) => n.daten));
  const signatur = await signiereNutzlast(keypair, bytes);
  const ergebnis = await postfachApi.einliefern(
    { channel_id: kanalId, cert: certRoh, signatur, nutzlasten },
    cloudRoute()
  );
  return ergebnis?.uebersprungene_empfaenger ?? [];
}

export async function sendeInGruppe(
  kanalId: string,
  klartext: string,
  replyToId: string | null = null
): Promise<GruppenSendeErgebnis> {
  // Der Riegel VOR dem ersten Serveraufruf. `gruppenApi` verriegelt selbst
  // noch einmal (s. dort) — hier steht er trotzdem, weil sonst schon der
  // Geraeteschluessel geladen und ein Krypto-Konto angelegt wuerde.
  if (!PRIVATE_GRUPPEN_ENABLED) return { art: 'nicht_moeglich' };

  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) return { art: 'nicht_moeglich' };
  const eigeneUserId = cert.claims.user_id;

  // Schritt 1 — s. Modulkopf. Frisch, immer.
  const gruppe = await gruppenApi.lesen(kanalId);
  if (!gruppe) return { art: 'nicht_moeglich' };
  const mitgliederIds = gruppe.members.map((m) => m.user_id);

  // Schritt 2.
  const buendel = await keysApi.claim(mitgliederIds, cloudRoute());
  const ziel = gruppengeraeteBerechnen(
    buendel,
    mitgliederIds,
    eigeneUserId,
    cert.claims.device_pubkey
  );

  // Schritt 3.
  const wahl = sitzungWaehlen(
    await gruppensitzungLaden(kanalId),
    mitgliederIds,
    ziel.map((z) => z.geraet.device_pubkey),
    () => ({ sitzung: neueGruppensitzung(), sitzungId: neueSitzungId() }),
    Date.now()
  );
  const stand = wahl.stand;

  // Schritt 4 — nur an die Geraete, die den Schluessel dieser Sitzung noch
  // nicht haben.
  const nachzuliefern = new Set(wahl.nachzuliefern);
  const { nutzlasten: schluesselUmschlaege, beliefert } = await verteilUmschlaege(
    kanalId,
    stand.sitzungId,
    stand.sitzung.verteilschluessel(),
    ziel.filter((z) => nachzuliefern.has(z.geraet.device_pubkey))
  );

  // Schritt 5.
  const nachrichtId = lokaleNachrichtId();
  const geheimtext = stand.sitzung.verschluesseln(
    baueNachrichtNutzlast(klartext, nachrichtId, replyToId)
  );
  const daten = baueGruppenhuelle(stand.sitzungId, geheimtext);
  const alleGeraete = ziel.map((z) => z.geraet.device_pubkey);

  // Schritt 6 — sichern, BEVOR irgendetwas hinausgeht. `beliefert` bleibt
  // hier noch unveraendert (s. Schritt 8): der Zaehler steigt, die
  // Belieferung wird erst nach der Zustellung geglaubt.
  const nachSendung = standNachSendung(stand, []);
  await gruppensitzungSichern(kanalId, nachSendung);

  if (alleGeraete.length === 0) {
    // Kein Mitglied hat ein veroeffentlichtes Geraet — es gibt niemanden,
    // an den zugestellt werden koennte. Ein Einliefern ohne Empfaenger
    // wuerde der Server ohnehin ablehnen (`empfaenger` min_length=1).
    return { art: 'nicht_zugestellt' };
  }

  // Schritt 7. Zwei Aufteilungen, zwei verschiedene Server-Grenzen:
  //
  //  * je NUTZLAST hoechstens 64 Empfaenger (`inEmpfaengerBloecke`) — der
  //    Megolm-Geheimtext ist in jedem Block derselbe;
  //  * je ANFRAGE hoechstens `MAX_UMSCHLAEGE_JE_ANFRAGE` Umschlaege, sonst
  //    faellt die ganze Anfrage mit 400 (s. dort).
  //
  // **Die Schluessel gehen ZUERST hinaus, in eigenen Anfragen.** Der Server
  // vergibt Zustellungs-IDs aufsteigend und der Abholweg arbeitet sie in
  // dieser Reihenfolge ab — ein Empfaenger soll den Schluessel in der Hand
  // haben, bevor die Nachricht kommt. Umgekehrt bliebe sie einen Zyklus
  // liegen (verloren waere sie nicht, s. `empfangen.ts`).
  const uebersprungen = new Set<string>();
  for (const block of inBloecke(schluesselUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)) {
    for (const p of await einliefernEinmal(kanalId, cert.raw, keypair, block)) {
      uebersprungen.add(p);
    }
  }
  const nachrichtUmschlaege: PostfachNutzlast[] = inEmpfaengerBloecke(alleGeraete).map(
    (block) => ({ art: ART_GRUPPENNACHRICHT, daten, empfaenger: block })
  );
  let irgendwoZugestellt = false;
  for (const block of inBloecke(nachrichtUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)) {
    const uebersprungeneDesBlocks = await einliefernEinmal(kanalId, cert.raw, keypair, block);
    // Ein Block gilt als zugestellt, wenn nicht JEDES seiner Geraete
    // uebersprungen wurde. `einliefernEinmal` liefert bei einem koerperlosen
    // 2xx eine leere Liste — dann steht hier korrekt „zugestellt".
    const geraeteImBlock = block.flatMap((n) => n.empfaenger);
    if (geraeteImBlock.some((g) => !uebersprungeneDesBlocks.includes(g))) {
      irgendwoZugestellt = true;
    }
  }
  if (!irgendwoZugestellt) return { art: 'nicht_zugestellt' };

  // Schritt 8 — jetzt erst gilt der Schluessel als verteilt, und nur an die
  // Geraete, die der Server nicht uebersprungen hat.
  // `standNachSendung` zaehlt die Nachricht mit — ein zweiter Aufruf
  // zaehlte sie doppelt. Deshalb hier direkt auf `nachSendung` aufgesetzt,
  // dessen Zaehler schon stimmt.
  const wirklichBeliefert = beliefert.filter((p) => !uebersprungen.has(p));
  if (wirklichBeliefert.length > 0) {
    await gruppensitzungSichern(kanalId, {
      ...nachSendung,
      beliefert: [...new Set([...nachSendung.beliefert, ...wirklichBeliefert])]
    });
  }

  // Schritt 9.
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
    // Zugestellt ist zugestellt — ein erneutes Einliefern waere ein
    // Duplikat. Der Fehlschlag wird deshalb sichtbar gemacht, nicht
    // verschluckt (dieselbe Regel wie im DM-Weg).
    verlaufZustand.melde(err);
  }
  return { art: 'gesendet', nachricht };
}
