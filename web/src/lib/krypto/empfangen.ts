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
 *
 * **Anhaenge (Etappe E): die Bytes werden VOR der Quittung geholt.** Das ist
 * keine Optimierung, sondern die einzige Gelegenheit. Das Recht, einen
 * verschluesselten Klumpen abzurufen, haengt an der eigenen OFFENEN
 * Zustellung (`postfach_anhaenge.py::darf_anhang_abrufen`) — die Quittung
 * loescht sie —, und der Klumpen selbst faellt, sobald die letzte Zustellung
 * quittiert ist (`postfach_pflege.py::sweep_verwaiste_anhaenge`). Wer erst
 * quittiert und dann laedt, laedt ins Leere, endgueltig. `anhaengeHolen`
 * laeuft deshalb innerhalb desselben `quittierbareIds`-Durchgangs, VOR
 * `verlaufSpeichernPflicht` und damit lange vor der Quittung.
 *
 * **Private Gruppen (Etappe G2) bringen zwei Abzweigungen mit**, beide unten
 * in `zustellungOeffnen` und beide hinter `PRIVATE_GRUPPEN_ENABLED`: eine
 * Megolm-Gruppennachricht (eigene Umschlagsart) laeuft gar nicht erst durch
 * den Olm-Weg, und ein entschluesselter Olm-Klartext wird ZUERST als
 * moeglicher Gruppen-Verteilschluessel gelesen. Warum diese Reihenfolge
 * feststeht: `gruppe/gruppenNutzlast.ts`-Modulkopf. Die Regeln dieses
 * Modulkopfs — nicht quittieren, was nicht sicher verwahrt ist; eine
 * scheiternde Zustellung haelt die uebrigen nicht auf — gelten dort
 * unveraendert.
 */
import type { Message } from '../api/types';
import {
  verlaufSpeichernPflicht,
  verlaufNachrichtGeloescht,
  verlaufLokaleIdFuerKryptoId
} from '../verlauf';
import { lokaleIdsFuerLoeschung } from './loeschZiel';
import { messages } from '../stores/messages.svelte';
import { verlaufZustand } from '../verlauf/zustand.svelte';
import { postfachApi } from '../api/postfach';
import { serversStore } from '../api/servers.svelte';
import { kryptoAccountLaden } from './account.svelte';
import { geraeteKennung } from './geraeteKennung';
import { anhaengeHolen } from './anhangHolen';
import { quittierbareIds, type KanalGruppe } from './quittierbareIds';
import { verarbeiteMitWiederherstellung } from './postfachSchleife';
import { KontoSicherungFehlgeschlagen, zustellungOeffnen } from './zustellungOeffnen';
import { mitKontosperre } from './sperren';
import { mitNachlaufBeiWeckung } from './postfachNachlauf';

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

async function postfachZyklus(): Promise<Message[]> {
  // `geraeteKennung()` wirft, wenn sich keine Kennung ermitteln laesst
  // (nicht angemeldet) — und genau das muss hier ANDERS enden als ein
  // durchgereichter Fehler: ohne diesen Fang wuerde der Wurf als
  // unbehandelte Ablehnung im Aufrufer verschwinden
  // (`ws/handlers/chat.ts`/`ready.ts` haengen keine `.catch` an den
  // Ruecklauf) — ein Abholzyklus, der bei jedem Weckruf erneut denselben
  // stummen Fehler wirft, ohne dass der Nutzer je etwas davon merkt. Statt
  // dessen: sichtbar machen (dieselbe Anzeige wie fuer Ablage-/Quittungs-
  // Fehler unten) und wie ein leerer Zyklus zurueckgeben — der naechste
  // Weckruf versucht es erneut, s. `verlauf/zustand.svelte.ts`.
  let kennung: string;
  try {
    kennung = await geraeteKennung();
  } catch (err) {
    verlaufZustand.melde(err);
    return [];
  }

  const zustellungen = await postfachApi.abholen({ device_pubkey: kennung }, cloudRoute());
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
  // Zwei Faelle, die direkt quittierbar sind — ohne Umweg ueber
  // `verlaufSpeichernPflicht` (es gibt nichts abzulegen) und OHNE Eintrag in
  // `geoeffnet` (sonst wuerde `ws/handlers/chat.ts` sie als neu/ungelesen
  // behandeln): eine Zustellung, deren Klartext schon vor diesem Zyklus
  // abgelegt war (FIX 3, Runde 3), und ein Gruppen-Verteilschluessel, der
  // seine Sitzung bereits angelegt hat (Etappe G2).
  const schonQuittierbar: string[] = [];
  // `verlaufSpeichernPflicht` nimmt einen Kanal je Aufruf — gleich beim
  // Oeffnen nach Kanal gruppieren, eine Abholung kann mehrere Gespraeche
  // mitbringen. `nachricht.id` ist die Zustellungs-ID (`id: z.id` in
  // `zustellungOeffnen`), ein separates Nachschlagen der Zustellung entfaellt.
  const nachKanal = new Map<string, KanalGruppe>();

  for (const ergebnis of ergebnisse) {
    if (!ergebnis) continue;
    if (ergebnis.art === 'loeschung') {
      // Lösch-Frame (2026-09-02): lokal Grabstein setzen (zusammen mit dem
      // Sicherungs-Grabstein in `verlaufNachrichtGeloescht`) und aus der
      // Anzeige nehmen — nichts abzulegen, direkt quittierbar.
      //
      // Der Frame nennt die ABSENDER-ID; hier liegt die Nachricht unter der
      // Zustellungs-ID mit der Absender-ID als `krypto_id` (s.
      // `loeschZiel.ts`). Erst die geladene Anzeige, dann der Verlauf — die
      // Nachricht kann aelter sein als das, was gerade geladen ist. Ohne
      // Treffer bleibt der Frame-Wert selbst stehen: der Grabstein auf eine
      // unbekannte ID ist wirkungslos, der Frame wird trotzdem quittiert,
      // denn eine Nachricht, die nie ankam, kann auch nicht stehen bleiben.
      let ziele = lokaleIdsFuerLoeschung(
        ergebnis.nachrichtId,
        messages.for(ergebnis.channelId)
      );
      if (ziele.length === 0) {
        const imVerlauf = await verlaufLokaleIdFuerKryptoId(
          ergebnis.channelId,
          ergebnis.nachrichtId
        );
        ziele = [imVerlauf ?? ergebnis.nachrichtId];
      }
      for (const lokaleId of ziele) {
        verlaufNachrichtGeloescht(ergebnis.channelId, lokaleId);
        messages.remove(ergebnis.channelId, lokaleId);
      }
      schonQuittierbar.push(ergebnis.id);
      continue;
    }
    if (ergebnis.art === 'schonAbgelegt' || ergebnis.art === 'ohneAblage') {
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
      async (kanalId, nachrichten) => {
        // Reihenfolge, s. Modulkopf „Anhaenge": ERST die Bytes holen, DANN
        // ablegen, und quittiert wird erst durch `quittierbareIds` danach.
        await anhaengeHolen(kanalId, nachrichten as Message[]);
        return verlaufSpeichernPflicht(kanalId, nachrichten as Message[]);
      },
      (err) => verlaufZustand.melde(err)
    )),
    ...schonQuittierbar
  ];

  if (quittierbar.length > 0) {
    // ERST JETZT quittieren, s. Modulkopf.
    await postfachApi.quittieren(
      { device_pubkey: kennung, zustellung_ids: quittierbar },
      cloudRoute()
    );
  }

  return geoeffnet;
}

/**
 * Holt alle offenen Zustellungen dieses Geraets ab, entschluesselt was sich
 * oeffnen laesst, legt es im lokalen Verlauf ab und quittiert erst danach.
 * Gibt die geoeffneten Nachrichten zurueck (fuer die sofortige Anzeige).
 *
 * **Der ganze Zyklus laeuft unter der Konto-Sperre** (Bughunt 2026-08-29,
 * s. `sperren.ts`) — nicht bloss das Sichern, und nicht bloss der
 * Sitzungsaufbau. Der Zyklus laedt EIN `Identitaet`-Objekt und mutiert es
 * ueber alle Zustellungen hinweg (jeder eingehende Sitzungsaufbau verbraucht
 * einen Einmalschluessel auf dem Account, s. Modulkopf); geschuetzt werden
 * muss deshalb die ganze Spanne vom Laden bis zum letzten Sichern. Zwei
 * Wirkungen fallen dabei zusammen an:
 *
 *  * Ein zweiter Tab kann nicht gleichzeitig veroeffentlichen und dabei die
 *    Einmalschluessel dieses Zyklus ueberschreiben (oder umgekehrt).
 *  * Zwei Tabs holen nicht gleichzeitig denselben Bestand ab. `abholen`
 *    liegt bewusst MIT unter der Sperre: erst dadurch findet der zweite Tab
 *    die vom ersten schon quittierten Zustellungen gar nicht mehr vor,
 *    statt sie ein zweites Mal zu oeffnen.
 *
 * **Nur EIN Abholzyklus gleichzeitig IN DIESEM TAB** (Bughunt 2026-08-28,
 * FIX 3, erweitert 2026-08-31) — zwei Ausloeser koennen kurz hintereinander
 * (oder gleichzeitig) eintreffen: `postfach_neu` (`ws/handlers/chat.ts`, je
 * Weckruf) und `ready` (`ws/handlers/ready.ts`, jeder Connect/Reconnect).
 * Keiner der beiden Aufrufer haelt eine eigene Wache; `mitNachlaufBeiWeckung`
 * (`postfachNachlauf.ts`) sorgt dafuer, dass eine Weckung waehrend eines
 * laufenden Zyklus NICHT einfach verschluckt wird, sondern nach dessen Ende
 * genau einen weiteren Zyklus ausloest — nacheinander, nie gleichzeitig, und
 * egal wie viele Weckungen waehrenddessen eintreffen (Details + Begruendung
 * im Modulkopf dort).
 */
export const postfachAbholenUndEntschluesseln = mitNachlaufBeiWeckung(() =>
  mitKontosperre(postfachZyklus)
);
