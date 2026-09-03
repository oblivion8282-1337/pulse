/**
 * Schluessel-Uebergabe an neue Geraete, OHNE eine Nachricht zu senden —
 * herausgeloest aus `kanalSenden.ts`, weil die Datei sonst ueber die
 * Groessen-Grenze gewachsen waere (350 Z., s. `CLAUDE.md`). Die drei
 * Bausteine hier (`zielGeraeteBerechnen`, `schluesselUmschlaegeBauen`,
 * `schluesselUmschlaegeEinliefern`) sind bewusst geteilt: `sendeInKanal`
 * ruft sie in exakt derselben Reihenfolge, nur mit einem Nachrichtenteil
 * dazwischen (s. dort). Wer diese Reihenfolge aendert, aendert sie an
 * BEIDEN Aufrufstellen.
 *
 * ## Was das kostet — und warum die Reihenfolge hier eine andere ist
 *
 * `keysApi.claim` VERBRAUCHT je fremdem Geraet einen Einmalschluessel
 * (`routes/schluessel_abholen.py`). Diese Funktion laeuft bei JEDEM
 * Kanal-Oeffnen; sie rief `claim` frueher fuer alle Mitglieder, bevor
 * ueberhaupt feststand, ob etwas nachzuliefern ist — und meist war nichts
 * nachzuliefern. Heute rechnet `nachlieferBedarf` das Delta zuerst aus der
 * verbrauchsfreien Geraeteliste (`POST /keys/geraeteliste`) und `claim`
 * laeuft nur noch fuer die Konten, deren Geraete den Schluessel wirklich
 * noch nicht haben. `sendeInKanal` bleibt unveraendert: dort wird ohnehin
 * verschluesselt und zugestellt, der Aufbau lohnt sich immer.
 *
 * **`schluesselUmschlaegeBauen` MUSS vor jeder Nachrichtenverschluesselung
 * laufen.** `verteilschluessel()` liest den Ratchet-Stand VOR dem
 * Verschluesseln — kaeme die Verschluesselung zuerst, saehe ein neu
 * belieferter Geraet die gerade verschickte Nachricht nicht mehr (der
 * Ratchet waere schon einen Schritt weiter). `sendeInKanal` haelt sich
 * daran, indem es diese Funktion vor `stand.sitzung.verschluesseln()` ruft.
 *
 * ## Die Grenze dieser Nachlieferung, ausdruecklich
 *
 * Nachgeliefert wird **genau eine** Sitzung: die AUSGEHENDE dieses Geraets
 * (`gruppensitzungLaden`, ein Eintrag je Kanal). Ein Geraet fuehrt daneben
 * beliebig viele EINGEHENDE Sitzungen — eine je (Kanal, Absendergeraet,
 * Sitzungskennung), s. `gruppenSitzungen.ts` — und **keine davon kann es
 * weiterreichen.** `Gruppenempfang` bietet nur `entschluesseln`,
 * `einfrieren` und `auftauen`; einen Export gibt es nicht, weder in der
 * WASM-Grenze (`krypto/pulse-krypto/src/wasm.rs`) noch in der Kiste selbst
 * (`gruppe.rs`), und vodozemacs `InboundGroupSession::export_at` ist dort
 * bewusst nicht durchgereicht: an ihm haengt die Zusicherung „wer spaeter
 * dazukommt, liest den Verlauf davor nicht" (Modulkopf von `gruppe.rs`).
 *
 * **Praktische Folge, und sie ist keine Kleinigkeit:** ein frisches Geraet
 * bekommt hierueber den Schluessel fuer alles, was DIESES Geraet ab jetzt
 * sendet — nicht fuer das, was ANDERE Mitglieder gesendet haben. Den
 * Verlauf eines Ordner-Kanals sieht es deshalb erst, wenn jedes andere
 * sendende Geraet seinerseits nachgeliefert hat (was es beim naechsten
 * Kanal-Oeffnen tut, s. `components/chat/ablageKanalVerlauf.ts`), und fuer
 * Nachrichten aus einer laengst abgeloesten Sitzung eines Geraets, das nicht
 * wiederkommt, gar nicht. Das aufzuheben hiesse, `export_at` freizugeben —
 * eine Entscheidung ueber die Vorwaertssicherheit des Kanals, nicht eine
 * Erweiterung dieser Datei.
 */
import type { PostfachNutzlast } from '../../api/postfach';
import { keysApi } from '../../api/keys';
import { serversStore } from '../../api/servers.svelte';
import { auth } from '../../stores/auth.svelte';
import { guilds } from '../../stores/guilds.svelte';
import { geraeteKennung } from '../geraeteKennung';
import { mitGruppensitzungssperre } from '../sperren';
import { ABLAGE_KANAL_ENABLED } from '../../featureFlags';
import { sitzungWaehlen, type Gruppenstand } from './kanalSitzungswahl';
import { kanalMitgliederMitSicht } from './kanalMitglieder';
import { bloeckeEinliefern, verteilUmschlaege } from './gruppenEinliefern';
import { kanalLaufwerkSchluesselLaden } from '../../ablage/kanalLaufwerkSchluessel';
import { neueSitzungId } from './gruppenNutzlast';
import { gruppensitzungLaden, gruppensitzungSichern, neueGruppensitzung } from './gruppenSitzungen';
import {
  gruppengeraeteBerechnen,
  inBloecke,
  MAX_UMSCHLAEGE_JE_ANFRAGE,
  type Gruppenzielgeraet
} from './gruppengeraete';
import { nachlieferBedarf } from './nachlieferBedarf';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Zielgeraete fuer `mitgliederIds` beschaffen (Geraete-Buendel claimen +
 *  auf die eigentliche Zielliste eindampfen) — der gemeinsame erste Schritt
 *  von `sendeInKanal` und `kanalSchluesselNachliefern`, s. Modulkopf. */
export async function zielGeraeteBerechnen(
  mitgliederIds: string[],
  eigeneUserId: string,
  eigeneKennung: string
): Promise<Gruppenzielgeraet[]> {
  const buendel = await keysApi.claim(mitgliederIds, cloudRoute());
  return gruppengeraeteBerechnen(buendel, mitgliederIds, eigeneUserId, eigeneKennung);
}

/** Baut die Verteilschluessel-Umschlaege fuer die Geraete in `nachzuliefern`
 *  — s. Modulkopf zur Reihenfolge-Regel. Reiner Baustein, liefert nichts
 *  ein. */
export async function schluesselUmschlaegeBauen<S extends { verteilschluessel(): string }>(
  kanalId: string,
  stand: Gruppenstand<S>,
  ziel: Gruppenzielgeraet[],
  nachzuliefern: Set<string>
): Promise<PostfachNutzlast[]> {
  // Kennt DIESES Geraet den Ablage-Hauptschluessel + die Freigabe-Adresse
  // (Kanal selbst verbunden ODER frueher ueber das Postfach empfangen —
  // beide Faelle landen im selben Speicher, s. `kanalLaufwerkSchluessel.ts`),
  // reist beides mit derselben Zustellung wie die Gruppensitzung mit
  // (Design §3.1). Kennt es sie nicht (gewoehnliches Mitgliedsgeraet, das
  // selbst noch nichts empfangen hat), bleibt `ablage` `undefined` — die
  // naechste Sendung/Nachlieferung eines Geraets, das sie kennt, liefert sie
  // nach.
  const ablage = await kanalLaufwerkSchluesselLaden(kanalId);
  return verteilUmschlaege(
    kanalId,
    stand.sitzungId,
    stand.sitzung.verteilschluessel(),
    ziel.filter((z) => nachzuliefern.has(z.geraet.device_pubkey)),
    ablage ?? undefined
  );
}

/** Liefert bereits gebaute Schluessel-Umschlaege ein — der gemeinsame
 *  Netzschritt von `sendeInKanal` und `kanalSchluesselNachliefern`. Traegt
 *  nie `archiv` (das Feld gehoert nur zur eigentlichen Nachricht, s.
 *  `sendeInKanal`). */
export async function schluesselUmschlaegeEinliefern(
  kanalId: string,
  eigeneKennung: string,
  schluesselUmschlaege: PostfachNutzlast[]
): Promise<Set<string>> {
  const { beliefert } = await bloeckeEinliefern(
    kanalId,
    eigeneKennung,
    inBloecke(schluesselUmschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE)
  );
  return beliefert;
}

/**
 * Reicht die Gruppensitzung (+ ggf. Ablage-Hauptschluessel) an Geraete nach,
 * die sie noch nicht kennen — OHNE eine Nachricht zu verschluesseln. Ruft
 * dieselben Bausteine wie `sendeInKanal` in derselben Reihenfolge, nur ohne
 * den Nachrichtenteil (Design §5: die Uebergabe soll reisen, sobald ein
 * Mitglied online ist, nicht erst mit der naechsten Sendung).
 *
 * **Zaehlt NICHT als Nachricht.** `standNachSendung` erhoeht `nachrichten`
 * (Sitzungswechsel nach `hoechstzahlNachrichten`) — das waere hier falsch,
 * es wurde ja nichts verschluesselt. Der Stand wird deshalb ungezaehlt
 * gesichert, einmal vor der Zustellung (fuer eine neu angelegte Sitzung —
 * sonst legte der naechste Aufruf, ohne dass zwischendurch gesendet wurde,
 * dieselbe Sitzung ein zweites Mal an) und danach erneut mit dem
 * aktualisierten `beliefert`.
 *
 * **Best-effort, wie jeder andere Kanal-Ladeschritt.** Der Aufrufer
 * (`ablageKanalVerlauf.ts`) faengt Fehler ab — dieser Weg darf den
 * Verlaufs-Ladepfad nie stoeren.
 */
export async function kanalSchluesselNachliefern(kanalId: string): Promise<void> {
  if (!ABLAGE_KANAL_ENABLED) return;
  if (!auth.user) return;
  const guildId = guilds.guildIdForChannel(kanalId);
  if (!guildId) return;
  const eigeneUserId = auth.user.id;
  const eigeneKennung = await geraeteKennung();

  const mitgliederIds = await kanalMitgliederMitSicht(guildId, kanalId);
  // **Erst die verbrauchsfreie Liste, dann erst `claim`** (s. Modulkopf,
  // „Was das kostet"). `geraeteliste` ruehrt keinen Einmalschluessel an.
  const geraeteJeKonto = await keysApi.geraeteliste(mitgliederIds, cloudRoute());

  // Dieselbe Sperre wie `sendeInKanal`, aus demselben Grund (Modulkopf):
  // die ausgehende Megolm-Sitzung liegt im Browserprofil, nicht im Tab.
  // Der `claim` liegt hier INNERHALB der Sperre — anders als beim Senden,
  // weil erst der gespeicherte Stand sagt, ob ueberhaupt einer noetig ist.
  return mitGruppensitzungssperre(kanalId, async () => {
    const jetzt = Date.now();
    const vorhanden = await gruppensitzungLaden(kanalId);
    const bedarf = nachlieferBedarf(
      vorhanden,
      mitgliederIds,
      geraeteJeKonto,
      eigeneUserId,
      eigeneKennung,
      jetzt
    );
    // Nichts offen -> kein `claim`, kein Vorratsverbrauch beim Gegenueber.
    // Auch eine faellige Rotation ohne ein einziges Zielgeraet faellt
    // hierunter: es gaebe niemanden zu beliefern, und die neue Sitzung
    // entsteht dann beim naechsten Senden.
    if (bedarf.konten.length === 0) return;

    const ziel = await zielGeraeteBerechnen(bedarf.konten, eigeneUserId, eigeneKennung);
    const wahl = sitzungWaehlen(
      vorhanden,
      mitgliederIds,
      ziel.map((z) => z.geraet.device_pubkey),
      () => ({ sitzung: neueGruppensitzung(), sitzungId: neueSitzungId() }),
      jetzt
    );
    const stand = wahl.stand;
    const nachzuliefern = new Set(wahl.nachzuliefern);
    if (nachzuliefern.size === 0) {
      // Nur bei einer neuen Sitzung ist hier ueberhaupt etwas zu sichern —
      // eine weiterlaufende, voll belieferte Sitzung ist in IndexedDB
      // bereits genau dieser Stand.
      if (wahl.grund !== null) await gruppensitzungSichern(kanalId, stand);
      return;
    }

    await gruppensitzungSichern(kanalId, stand);
    const schluesselUmschlaege = await schluesselUmschlaegeBauen(kanalId, stand, ziel, nachzuliefern);
    if (schluesselUmschlaege.length === 0) return;

    const beliefert = await schluesselUmschlaegeEinliefern(kanalId, eigeneKennung, schluesselUmschlaege);
    if (beliefert.size > 0) {
      await gruppensitzungSichern(kanalId, {
        ...stand,
        beliefert: [...new Set([...stand.beliefert, ...beliefert])]
      });
    }
  });
}
