/**
 * Holt Postfach-Zustellungen ab, entschluesselt sie und legt sie lokal ab —
 * Task 3 der Etappe D2 (`docs/superpowers/plans/2026-08-28-etappe-d2-klient-
 * verschluesselt.md`).
 *
 * Ablauf je Zustellung, unter `mitSitzungssperre` (Bughunt 2026-08-28,
 * FIX 3, s. `sitzungen.ts` Modulkopf — schuetzt gegen einen gleichzeitigen
 * Sendeversuch oder eine zweite Abholung auf derselben Sitzung):
 *
 *  1. Sitzung laden. Gibt es noch keine UND ist es ein Sitzungsaufbau
 *     (`art === 0`), ueber `sitzungEingehend` eine neue anlegen — der
 *     Klartext der ersten Nachricht kommt dabei gleich mit.
 *  2. Sitzung SICHERN — beim Sitzungsaufbau ATOMAR mit dem Account (Bughunt
 *     2026-08-28, FIX 2): `sitzungEingehend` verbraucht einen Einmalschluessel
 *     AUF DEM ACCOUNT (`&mut self` in `identitaet.rs`). Ein blosses
 *     Nachreichen von `kryptoAccountSichern` waere hier die falsche
 *     Reparatur: schlaegt danach das Sichern der Sitzung fehl, ist der
 *     Einmalschluessel vom Account verschwunden, waehrend nirgends eine
 *     Sitzung dafuer liegt — die noch unquittierte Zustellung kaeme beim
 *     naechsten Versuch zurueck und waere dann NIE MEHR zu oeffnen.
 *     `sitzungMitKontoAtomarSichern` (s. `sitzungen.ts`) schreibt deshalb
 *     beide Pickles in EINER Transaktion.
 *  3. Klartext in den lokalen Verlauf ablegen.
 *  4. **Erst DANACH quittieren** (`POST /postfach/quittung`) — die wichtigste
 *     Reihenfolge des ganzen Vorhabens. Die Quittung loescht den Umschlag auf
 *     dem Server, und es gibt keine zweite Kopie: wer vor dem Ablegen
 *     quittiert, verliert die Nachricht bei jedem Fehler zwischen beidem,
 *     unwiederbringlich.
 *
 * **Ein unlesbarer Umschlag wird NICHT quittiert.** Fehlt die Sitzung (und
 * ist es kein Sitzungsaufbau), fehlt der Curve25519-Schluessel fuer einen
 * Sitzungsaufbau, oder wirft der Krypto-Kern — die Zustellung bleibt liegen.
 * Ein voruebergehender Fehler waere sonst ein endgueltiger Verlust; die
 * serverseitige Frist raeumt sie irgendwann auf, wenn sie wirklich nie zu
 * oeffnen ist (s. Plan, „was dieser Plan NICHT loest").
 *
 * **Ebenso NICHT quittiert (Bughunt 2026-08-28, FIX 1): eine Zustellung, die
 * zwar entschluesselt, aber lokal NICHT abgelegt werden konnte.** Die alte
 * Fassung quittierte unbedingt, sobald etwas entschluesselt war — ein
 * fehlgeschlagenes Schreiben war dann endgueltig: die Quittung hatte den
 * Server-Umschlag schon geloescht, und die Olm-Sitzung war laengst ueber die
 * Nachricht hinaus weitergedreht. Jetzt wird je Kanal erst nach einer
 * ERFOLGREICHEN Ablage quittiert (`verlaufSpeichernPflicht`); ein
 * Fehlschlag laesst nur die Zustellungen DIESES Kanals unquittiert, der
 * naechste Weckruf versucht sie erneut.
 *
 * **Zweiter Bughunt (2026-08-28, FIX 2): EIN geladenes `Identitaet`-Objekt
 * fuer den GANZEN Abholzyklus, mutiert von jedem Sitzungsaufbau.** Ein
 * eingehender Sitzungsaufbau (`ident.sitzungEingehend`) verbraucht einen
 * Einmalschluessel AUF DEM ACCOUNT, im Arbeitsspeicher, sofort — unabhaengig
 * davon, ob das anschliessende `sitzungMitKontoAtomarSichern` gelingt. Wirft
 * dieses Sichern (z. B. voller Speicher, kurzzeitig blockierte IndexedDB),
 * wird die Zustellung korrekt NICHT quittiert — aber der bereits verbrauchte
 * Einmalschluessel bleibt im mutierten `ident` stehen. Kommt DANACH in
 * DERSELBEN Schleife eine WEITERE Zustellung, deren Sitzungsaufbau erfolgreich
 * sichert, friert dieser Aufruf den KUMULIERTEN Kontostand ein — inklusive
 * des Einmalschluessels der ersten, nie gesicherten Zustellung. Der ist damit
 * dauerhaft weg, obwohl fuer die erste Zustellung nie eine Sitzung gelandet
 * ist: sie kommt beim naechsten Weckruf zurueck und ist dann NIE MEHR zu
 * oeffnen (derselbe curve25519-Schluessel wird kein zweites Mal ausgegeben).
 * Die Atomaritaet von `sitzungMitKontoAtomarSichern` deckt nur den
 * SCHREIBVORGANG — nicht den Umstand, dass zwei Zustellungen sich denselben
 * mutierbaren Zustand im Arbeitsspeicher teilen.
 *
 * **Dritter Bughunt (Runde 3), FIX 2 — die Reparatur oben war zu grob.** Bis
 * hierhin brach `postfachZyklus` den GESAMTEN Rest ab, sobald ein
 * Konto-Sichern fehlschlug. `POST /postfach/abholen` liefert nach stabiler
 * ID-Reihenfolge (FIFO) — eine einzelne DAUERHAFT scheiternde Zustellung
 * (echt volle IndexedDB) sortiert sich damit bei jedem Zyklus an den Anfang
 * und blockierte so jede Zustellung dahinter, in jedem Kanal. Die
 * Korrektheits-Eigenschaft von oben bleibt (kein `ident` mit ungesicherter
 * Mutation einer vorherigen Zustellung darf weiterverwendet werden) — nur
 * die Reaktion aendert sich: statt abzubrechen, laesst `verarbeiteMit-
 * Wiederherstellung` (`postfachSchleife.ts`) NUR diese eine Zustellung liegen
 * und laedt `ident` fuer die naechste FRISCH aus IndexedDB (den zuletzt
 * durabel gesicherten Stand, ohne die verlorene Mutation). Alle anderen
 * Zustellungen dieses Zyklus laufen normal weiter.
 *
 * **Dritter Bughunt (Runde 3), FIX 3 — eine abgelegte, aber nicht quittierte
 * Zustellung darf nicht dauerhaft haengen bleiben.** Scheitert NACH
 * erfolgreicher Ablage NUR `POST /postfach/quittung`, bleibt die Zustellung
 * auf dem Server liegen und kommt unveraendert zurueck — aber die Olm-
 * Sitzung ist laengst ueber sie hinaus geratscht: ein zweiter Entschluesse-
 * lungsversuch scheitert GRUNDSAETZLICH, die Zustellung bliebe bis zur
 * 30-Tage-Frist unquittiert liegen (einer von 500 offenen Zustellungs-
 * Plaetzen dauerhaft belegt). `zustellungOeffnen` prueft deshalb GANZ ZU
 * BEGINN — vor Sitzungssperre, `absenderErmitteln`, jedem Entschluesseln —,
 * ob unter (`channel_id`, `id`) bereits ein Satz im lokalen Verlauf liegt
 * (`verlaufSchonAbgelegt`, `verlauf/db.ts::verlaufSatzVorhanden`). Ein Treffer
 * ist der Beweis, dass GENAU DIESE Zustellung schon einmal durch echtes
 * Entschluesseln abgelegt wurde — sie darf dann OHNE erneutes Entschluesseln
 * quittiert werden. **Bewusst NICHT entsteht** dafuer ein neuer, persistenter
 * Cache aus Klartext oder "quittierbar"-Markierungen, indiziert allein ueber
 * die vom Server vergebene Zustellungs-ID — das waere ein Vertrauens-Speicher,
 * den ein Server durch Wiederverwenden einer ID fuellen koennte, ohne dass
 * der Klient je wieder prueft, was wirklich drinsteht. Die Pruefung fragt
 * stattdessen den EIGENEN, bereits durch echtes Entschluesseln geschriebenen
 * Bestand — ein Treffer heisst nur "wir haben das schon selbst abgelegt",
 * nie "der Server behauptet etwas ueber diese ID".
 */
import type { Message } from '../api/types';
import type { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { Umschlag } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { certStore } from '../identity/cert.svelte';
import { loadKeypair } from '../identity/keypair.svelte';
import { directMessages } from '../stores/directMessages.svelte';
import { verlaufSpeichernPflicht, verlaufSchonAbgelegt } from '../verlauf';
import { verlaufZustand } from '../verlauf/zustand.svelte';
import { postfachApi, type PostfachZustellung } from '../api/postfach';
import { serversStore } from '../api/servers.svelte';
import { kryptoAccountLaden } from './account.svelte';
import {
  sitzungLaden,
  sitzungSichern,
  sitzungMitKontoAtomarSichern,
  mitSitzungssperre
} from './sitzungen';
import { baueNutzlast } from './nutzlast';
import { signiereNutzlast } from './nachweis';
import { absenderErmitteln } from './absenderErmitteln';
import { quittierbareIds, type KanalGruppe } from './quittierbareIds';
import { verarbeiteMitWiederherstellung } from './postfachSchleife';
import { parseMentionMarkers } from '../components/mentionMarkierungen';

/**
 * Markiert, dass `sitzungMitKontoAtomarSichern` fuer eine Zustellung
 * fehlgeschlagen ist, NACHDEM `ident` bereits mutiert wurde (Bughunt
 * 2026-08-28, FIX 2, s. Modulkopf). Absichtlich eine eigene Klasse statt
 * eines rohen Fehlers: `zustellungOeffnen`s Catch-Block muss sie von einem
 * gewoehnlichen Entschluesselungsfehler (unlesbarer Umschlag — dort bleibt
 * die Zustellung einfach liegen, der Zyklus laeuft normal weiter) unterscheiden
 * koennen.
 */
class KontoSicherungFehlgeschlagen extends Error {}

// DMs sind heute cloud-only (Global-Friends Stufe 1) — s. `api/keys.ts`
// Modulkopf (Bughunt 2026-08-28, FIX 4). Ohne diesen Parameter faellt
// `request()` auf `activeServer.current` zurueck, also den zuletzt
// gewaehlten Self-Host — dort existiert weder das Postfach noch das
// Schluesselverzeichnis fuer diesen Kanal. `senden.ts`/`veroeffentlichen.ts`
// uebergeben dieselbe Route bereits; dieses Modul war beim Nachziehen von
// FIX 4 bei einem anderen Agenten in Arbeit und ist erst hier nachgezogen.
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Ergebnis eines Oeffnungsversuchs — entweder eine neu entschluesselte
 *  Nachricht, oder eine Zustellung, die schon frueher entschluesselt und
 *  abgelegt wurde und nur noch die (bislang fehlgeschlagene) Quittung
 *  braucht (Bughunt-Runde 3, FIX 3, s. Modulkopf). `null`, wenn sie liegen
 *  bleiben muss. */
type ZustellungOffenErgebnis =
  | { art: 'neu'; nachricht: Message }
  | { art: 'schonAbgelegt'; channelId: string; id: string }
  | null;

/** Die Nachricht einer erfolgreich geoeffneten Zustellung — `null`, wenn der
 *  Absender nicht ermittelbar ist: der Server liefert keinen
 *  `absender_user_id` (Sendegeraet zwischenzeitlich abgemeldet, s.
 *  `absenderErmitteln.ts`), UND der Kanal ist lokal (noch) nicht als
 *  Rueckfall bekannt (kann bei einer brandneuen DM knapp vor dem
 *  `ready`-Rahmen passieren; die naechste Abholung holt sie dann nach, s.
 *  Modulkopf „unlesbar"). */
async function zustellungOeffnen(
  ident: Identitaet,
  z: PostfachZustellung
): Promise<ZustellungOffenErgebnis> {
  // FIX 3 (Bughunt-Runde 3, s. Modulkopf) — ZUERST pruefen, noch vor jeder
  // Sitzungssperre und jedem Entschluesseln: liegt der Klartext schon lokal,
  // braucht es beides nicht mehr.
  if (await verlaufSchonAbgelegt(z.channel_id, z.id)) {
    return { art: 'schonAbgelegt', channelId: z.channel_id, id: z.id };
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
        // Sichern VOR dem Quittieren — s. Modulkopf.
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
        // ATOMAR mit dem Konto sichern — s. Modulkopf. Ab hier ist `ident`
        // bereits mutiert (der Einmalschluessel ist verbraucht); ein
        // Fehlschlag hier darf NUR diese eine Zustellung liegen lassen
        // (FIX 2, Runde 3), darum ein eigener, nicht-schluckbarer Fehlertyp
        // statt des normalen "unlesbar liegenlassen".
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

      const klartext = new TextDecoder().decode(klartextBytes);
      return {
        art: 'neu',
        nachricht: {
          // Snowflake der Zustellung: digit-only wie ein echter Server-
          // Snowflake, sortiert also im lokalen Verlauf korrekt nach Zeit.
          id: z.id,
          channel_id: z.channel_id,
          author_id: absenderUserId,
          content: klartext,
          nonce: null,
          created_at: new Date().toISOString(),
          // Lokal geparst, s. `mentionMarkierungen.ts`-Modulkopf.
          mentions: parseMentionMarkers(klartext),
          // Erkennungsmerkmal, s. `Message.verschluesselt` in `api/types.ts`.
          verschluesselt: true
        }
      };
    } catch (err) {
      if (err instanceof KontoSicherungFehlgeschlagen) {
        // Weiterreichen, NICHT hier verschlucken — `postfachZyklus` laesst
        // NUR diese eine Zustellung liegen (FIX 2, Runde 3, s. Modulkopf),
        // sonst friert die naechste erfolgreiche Zustellung den
        // kompromittierten Zwischenstand von `ident` ein.
        throw err;
      }
      // Entschluesseln fehlgeschlagen (fremde/kaputte Sitzung, korrupter
      // Umschlag) — NICHT quittieren, s. Modulkopf.
      return null;
    }
  });
}

async function postfachZyklus(): Promise<Message[]> {
  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) return [];

  const abholNutzlast = baueNutzlast('postfach-abholen');
  const abholSignatur = await signiereNutzlast(keypair, abholNutzlast);
  const zustellungen = await postfachApi.abholen(
    { cert: cert.raw, signatur: abholSignatur },
    cloudRoute()
  );
  if (zustellungen.length === 0) return [];

  let ident = await kryptoAccountLaden();
  // FIX 2 (Bughunt-Runde 3, s. Modulkopf + `postfachSchleife.ts`): laesst nur
  // die EINE Zustellung liegen, deren Konto-Sichern scheitert — `ident` wird
  // fuer die naechste Zustellung frisch aus IndexedDB geladen (der zuletzt
  // durabel gesicherte Stand, ohne die verlorene Mutation), damit kein
  // weiterer Aufruf den kompromittierten Zwischenstand einfrieren kann. Alle
  // anderen Zustellungen dieses Zyklus laufen normal weiter.
  const ergebnisse = await verarbeiteMitWiederherstellung(
    zustellungen,
    (z) => zustellungOeffnen(ident, z),
    (err) => err instanceof KontoSicherungFehlgeschlagen,
    async () => {
      ident = await kryptoAccountLaden();
    }
  );

  const geoeffnet: Message[] = [];
  // Zustellungen, deren Klartext schon vor diesem Zyklus abgelegt war (FIX 3,
  // Runde 3) — direkt quittierbar, ohne Umweg ueber `verlaufSpeichernPflicht`
  // (es gibt nichts mehr abzulegen) und OHNE Eintrag in `geoeffnet` (sonst
  // wuerde `ws/handlers/chat.ts` sie ein zweites Mal als neu/ungelesen
  // behandeln).
  const schonQuittierbar: string[] = [];
  // `verlaufSpeichernPflicht` nimmt einen Kanal je Aufruf — gleich beim
  // Oeffnen nach Kanal gruppieren, eine Abholung kann mehrere Gespraeche
  // mitbringen. `nachricht.id` ist die Zustellungs-ID (`id: z.id` in
  // `zustellungOeffnen`), ein separates Nachschlagen der Zustellung entfaellt.
  const nachKanal = new Map<string, KanalGruppe>();

  for (const ergebnis of ergebnisse) {
    if (!ergebnis) continue;
    if (ergebnis.art === 'schonAbgelegt') {
      schonQuittierbar.push(ergebnis.id);
      continue;
    }
    const nachricht = ergebnis.nachricht;
    geoeffnet.push(nachricht);
    const gruppe = nachKanal.get(nachricht.channel_id);
    if (gruppe) {
      gruppe.nachrichten.push(nachricht);
      gruppe.ids.push(nachricht.id);
    } else {
      nachKanal.set(nachricht.channel_id, { nachrichten: [nachricht], ids: [nachricht.id] });
    }
  }

  const quittierbar = [
    ...(await quittierbareIds(
      nachKanal,
      (kanalId, nachrichten) => verlaufSpeichernPflicht(kanalId, nachrichten as Message[]),
      (err) => verlaufZustand.melde(err)
    )),
    ...schonQuittierbar
  ];

  if (quittierbar.length > 0) {
    // ERST JETZT quittieren, s. Modulkopf.
    const quittungNutzlast = baueNutzlast('postfach-quittung', ...quittierbar);
    const quittungSignatur = await signiereNutzlast(keypair, quittungNutzlast);
    await postfachApi.quittieren(
      {
        cert: cert.raw,
        signatur: quittungSignatur,
        zustellung_ids: quittierbar
      },
      cloudRoute()
    );
  }

  return geoeffnet;
}

/** Nur EIN Abholzyklus gleichzeitig (Bughunt 2026-08-28, FIX 3) — zwei
 *  Ausloeser koennen kurz hintereinander (oder gleichzeitig) eintreffen:
 *  `postfach_neu` (`ws/handlers/chat.ts`, je Weckruf) und `ready`
 *  (`ws/handlers/ready.ts`, Bughunt-Runde 3 FIX 1 — jeder Connect/Reconnect).
 *  Keiner der beiden Aufrufer haelt eine eigene Wache; treffen mehrere kurz
 *  hintereinander ein, haengt sich jeder weitere nur an den bereits
 *  laufenden Zyklus an, statt denselben Bestand ein zweites Mal, unabhaengig,
 *  zu oeffnen. */
let laufenderZyklus: Promise<Message[]> | null = null;

/**
 * Holt alle offenen Zustellungen dieses Geraets ab, entschluesselt was sich
 * oeffnen laesst, legt es im lokalen Verlauf ab und quittiert erst danach.
 * Gibt die geoeffneten Nachrichten zurueck (fuer die sofortige Anzeige).
 */
export function postfachAbholenUndEntschluesseln(): Promise<Message[]> {
  if (!laufenderZyklus) {
    laufenderZyklus = postfachZyklus().finally(() => {
      laufenderZyklus = null;
    });
  }
  return laufenderZyklus;
}
