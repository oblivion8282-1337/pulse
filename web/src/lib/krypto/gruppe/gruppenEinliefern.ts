/**
 * Bloecke ins Postfach einliefern — herausgeloest aus `senden.ts` (Etappe G2,
 * Bughunt 2026-08-28/29, belegter Fehler), als die Datei mit der
 * Wiederherstellungslogik ueber die Groessen-Policy (PLAN.md §12.1)
 * gewachsen waere. Der Umzug selbst aendert kein Verhalten.
 *
 * **`verteilUmschlaege` kam am 2026-09-01 dazu** (Etappe E6, Ablage-Kanal):
 * derselbe Verteilschritt, den `senden.ts` fuer private Gruppen brauchte,
 * braucht `kanalSenden.ts` unveraendert fuer Ablage-Kanaele — beide bauen
 * Olm-Umschlaege fuer denselben Megolm-Verteilschluessel, nur die Herkunft
 * der Mitgliederliste unterscheidet sich (davor). Ein zweites Mal
 * hingeschrieben waere die Funktion eine zweite Stelle, an der ein Fehler in
 * der Sitzungssperren-Reihenfolge einschleichen koennte, ohne dass ein Test
 * den Abstand zwischen beiden Kopien pruefte.
 */
import { postfachApi, type PostfachNutzlast } from '../../api/postfach';
import { serversStore } from '../../api/servers.svelte';
import { kryptoAccountLaden } from '../account.svelte';
import {
  sitzungLaden,
  sitzungSichern,
  mitSitzungssperre,
  partnerSchluesselLesen,
  partnerSchluesselMerken
} from '../sitzungen';
import { baueVerteilNutzlast, type AblageVerteilzugabe } from './gruppenNutzlast';
import type { Gruppenzielgeraet } from './gruppengeraete';
import { geraetebuendelAuthentifizieren } from '../geraetePinnung';
import { BuendelUnsigniertFehler } from '../buendelSignatur';
import { melde } from '../../diagnose/app-diagnose';

function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Baut je Zielgeraet einen Olm-Umschlag mit dem Verteilschluessel. Geraete
 *  ohne verwertbaren Schluessel werden uebersprungen — sie bekommen ihn beim
 *  naechsten Mal, weil sie dann immer noch nicht in `beliefert` stehen.
 *  Ob ein gebauter Umschlag den Server auch WIRKLICH erreicht, entscheidet
 *  erst `bloeckeEinliefern` — hier entsteht nur die Kandidatenliste.
 *
 *  `ablage` ist nur bei Ablage-Kanaelen gesetzt: der Aufrufer gibt ihn
 *  weiter, wenn DIESES Geraet den Ablage-Hauptschluessel und die
 *  Freigabe-Adresse des Kanals kennt (Design §3.1) — jedes Ziel-Geraet
 *  dieses Aufrufs bekommt dann alle drei Dinge in einem Umschlag.
 *
 *  `absenderGeraet` ist die eigene Geraetekennung des Aufrufers und faehrt
 *  in der authentisierten Verteilnutzlast mit (Bughunt 2026-09-23): der
 *  Empfaenger registriert die eingehende Sitzung unter IHM, nicht unter dem
 *  Metadaten-Wert der Zustellung — sonst liesse sich der Sitzung ein
 *  falscher Inhaber unterschieben und jeder spaeteren Gruppennachricht ein
 *  falscher Absender. */
export async function verteilUmschlaege(
  kanalId: string,
  sitzungId: string,
  verteilschluessel: string,
  ziel: Gruppenzielgeraet[],
  ablage?: AblageVerteilzugabe,
  absenderGeraet?: string
): Promise<PostfachNutzlast[]> {
  const ident = await kryptoAccountLaden();
  const klartext = baueVerteilNutzlast(kanalId, sitzungId, verteilschluessel, ablage, absenderGeraet);
  const nutzlasten: PostfachNutzlast[] = [];
  // Vorzeichenlose Alt-Bündel je Gerät überspringen statt die ganze Verteilung
  // zu töten (Vorfall 2026-09-24 im DM-Weg: totes Altgerät blockierte jede
  // Zustellung an die lebenden Geräte). Nicht still — der Sprung geht in den
  // Käfer-Ring; bleibt kein signiertes Gerät übrig, wirft die Schleife
  // denselben Fehler wie vorher. Ein Mitglied VERLIERT den Verteilschluessel
  // dadurch nicht, das es gar nicht bekam: das alte Gerät hätte ihn nie
  // entpacken können.
  const unsignierteAltgeraete: string[] = [];
  for (const { geraet } of ziel) {
    // **Signatur + TOFU (Bughunt 2026-09-23)** — dieselbe geteilte
    // Authentifizierung wie im DM-Weg (`../geraetePinnung.ts`); hier ist sie
    // sogar der groesste Hebel: der Verteilschluessel der Gruppe geht durch
    // diese Umschlaege. Ungueltige Signatur und Pinnungs-Abweichung werfen
    // weiterhin hart; nur ein Bündel OHNE Signatur wird uebersprungen
    // (s. unsignierteAltgeraete oben).
    try {
      await geraetebuendelAuthentifizieren(geraet);
    } catch (err) {
      if (!(err instanceof BuendelUnsigniertFehler)) throw err;
      unsignierteAltgeraete.push(geraet.device_pubkey);
      continue;
    }

    const umschlag = await mitSitzungssperre(kanalId, geraet.device_pubkey, async () => {
      let sitzung = await sitzungLaden(kanalId, geraet.device_pubkey);
      if (sitzung) {
        // Bughunt Runde 10: derselbe Partner-Schluessel-Vergleich wie im
        // DM-Weg (senden.ts, Fix 2026-09-03) — trägt das Bundle einen
        // ANDEREN Identitätsschlüssel als den, für den die Sitzung gebaut
        // wurde (Frischstart desselben Geräts), war sie dort weg. Ohne den
        // Vergleich ging der Verteilschlüssel in eine tote Sitzung und
        // wurde als „beliefert" gebucht: nie wieder nachgeliefert.
        const gemerkt = await partnerSchluesselLesen(kanalId, geraet.device_pubkey);
        if (gemerkt !== geraet.curve25519) {
          console.warn('[gruppe] Gegenseite hat neuen Schlüsselbund — Sitzung wird neu aufgebaut');
          sitzung = null;
        }
      }
      if (!sitzung) {
        const einmal = geraet.einmalschluessel ?? geraet.rueckfallschluessel;
        if (!einmal) return null;
        sitzung = ident.sitzungAusgehend(geraet.curve25519, einmal);
      }
      const gebaut = sitzung.verschluesseln(klartext);
      // Sichern VOR dem Einliefern — s. `../sitzungen.ts`-Modulkopf. Der
      // gemerkte Partner-Schlüssel wandert mit (Spiegel zum DM-Weg).
      await partnerSchluesselMerken(kanalId, geraet.device_pubkey, geraet.curve25519);
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
  }
  if (unsignierteAltgeraete.length > 0) {
    melde(
      'gruppe',
      'buendel_unsigniert_uebersprungen',
      `Geräte ohne signiertes Bündel übersprungen: ${unsignierteAltgeraete.join(', ')}`
    );
  }
  if (nutzlasten.length === 0 && unsignierteAltgeraete.length > 0) {
    // Alles übersprungen, niemand bekommt den Verteilschluessel — derselbe
    // laute Fehler wie vor der Skip-Regel. Fail-closed.
    throw new BuendelUnsigniertFehler(unsignierteAltgeraete[0]);
  }
  return nutzlasten;
}

/**
 * Eine einzelne Einlieferung. Gibt die Geraete-Pubkeys zurueck, die der
 * Server uebersprungen hat (unbekanntes Buendel, Kontingent voll) — bei
 * einem koerperlosen 2xx eine leere Liste, denn dann hat er nichts
 * uebersprungen GESAGT, und ohne Gegenbeweis gilt zugestellt (dieselbe
 * Deutung wie `wurdeZugestellt`, s. `../zustellErgebnis.ts`).
 *
 * **Wirft absichtlich weiter.** Der DM-Weg faengt hier einen 404 ab und
 * faellt auf den Klartext zurueck (`../zustellErgebnis.ts`) — fuer eine
 * Gruppe gibt es diesen Weg nicht, ein verschluckter Fehler waere eine
 * Nachricht, die niemand bekommen hat und die niemand vermisst.
 */
export async function einliefernEinmal(
  kanalId: string,
  geraeteKennung: string,
  nutzlasten: PostfachNutzlast[]
): Promise<string[]> {
  const ergebnis = await postfachApi.einliefern(
    { channel_id: kanalId, device_pubkey: geraeteKennung, nutzlasten },
    cloudRoute()
  );
  return ergebnis?.uebersprungene_empfaenger ?? [];
}

/**
 * Liefert mehrere Bloecke NACHEINANDER ein und faengt den Fehlschlag EINES
 * Blocks ab, statt die Schleife abzubrechen. Ohne das riss ein einzelner
 * geworfener Block (z. B. ein Geraet darin, das gerade sein Kanal-Recht
 * verlor) alle NACHFOLGENDEN Bloecke mit — obwohl deren Empfaenger laengst
 * beliefert waren, bevor die Ausnahme den Aufrufer verliess. Der servereigene
 * Fix (`services/chat-gateway/.../routes/postfach.py`) nimmt genau diesen
 * Fall fuer ein entferntes Gruppenmitglied schon vorweg — dieser Wall bleibt
 * trotzdem die zweite Verteidigungslinie fuer jeden ANDEREN Fehlschlag
 * (Netz, ein voller Server, …).
 *
 * Gibt die Geraete zurueck, die TATSAECHLICH beliefert wurden: ein Block
 * zaehlt nur mit, wenn er nicht geworfen hat, und je Geraet nur, wenn der
 * Server es nicht selbst uebersprungen hat. Ein geworfener Block liefert
 * keinem seiner Geraete etwas — sie gelten beim naechsten Senden weiterhin
 * als offen (`nachzuliefern`/`sitzungWaehlen`).
 */
export async function bloeckeEinliefern(
  kanalId: string,
  geraeteKennung: string,
  bloecke: PostfachNutzlast[][]
): Promise<{ beliefert: Set<string>; letzterFehler: unknown }> {
  const beliefert = new Set<string>();
  let letzterFehler: unknown;
  for (const block of bloecke) {
    const geraeteImBlock = block.flatMap((n) => n.empfaenger);
    try {
      const uebersprungeneDesBlocks = await einliefernEinmal(kanalId, geraeteKennung, block);
      for (const g of geraeteImBlock) {
        if (!uebersprungeneDesBlocks.includes(g)) beliefert.add(g);
      }
    } catch (err) {
      letzterFehler = err;
    }
  }
  return { beliefert, letzterFehler };
}
