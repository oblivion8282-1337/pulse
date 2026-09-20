/**
 * Veroeffentlicht das Schluessel-Buendel dieses Geraets, sorgt fuer einen
 * veroeffentlichten Rueckfallschluessel und fuellt den Einmalschluessel-Vorrat
 * auf, wenn er zur Neige geht (E2E-DM Etappe B2, Rueckfallschluessel
 * nachgereicht — s. `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §2).
 *
 * Ohne veroeffentlichten Rueckfallschluessel wird ein Geraet unerreichbar,
 * sobald sein Einmalschluessel-Vorrat erschoepft ist — `POST /keys/claim`
 * liefert dann fuer dieses Geraet gar keinen Schluessel mehr, und eine neue
 * Sitzung laesst sich nicht mehr aufbauen.
 *
 * Best-effort beim Einstieg: laesst sich die eigene Geraetekennung nicht
 * ermitteln (noch nicht angemeldet), passiert nichts. Alles danach wirft
 * weiter, und wohin, haengt am Aufrufer: `runIssueFlow` und die
 * Cert-Rotation fangen ab und versuchen es beim naechsten Anlauf erneut,
 * `kopplung/empfangen.ts::kopplungEinloesen` ruft ungefangen — dort steht
 * ein Mensch davor, und eine Kopplung, die halb gelingt, darf nicht als
 * fertig aussehen.
 */
import type { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { keysApi } from '../api/keys';
import { serversStore } from '../api/servers.svelte';
import { isElectron, isCapacitorAndroid } from '../platform/runtime';
import {
  kryptoAccountLaden,
  kryptoAccountSichern,
  rueckfallschluesselSicherstellen
} from './account.svelte';
import { geraeteKennung } from './geraeteKennung';
import { pickelUebergangSicherstellen } from './pickelUebergang';
import { mitKontosperre } from './sperren';
import { verfallPruefen } from './verfallPruefen';

// DMs sind heute cloud-only (Global-Friends Stufe 1) — s. `api/keys.ts`
// Modulkopf (Bughunt 2026-08-28, FIX 4). Als FUNKTION statt Modul-Konstante:
// dieses Modul wird schon beim Login importiert (`issue-flow.ts`), bevor
// `serversStore.init()` den Cloud-Eintrag sicher angelegt hat — eine einmal
// zur Importzeit ausgewertete Konstante bliebe dann fuer die Lebensdauer des
// Moduls auf `undefined` stehen.
function cloudRoute(): { serverId?: string } {
  return { serverId: serversStore.cloudId() };
}

/** Ob DIESES Geraet dauerhaft ist — Electron- oder Android-App, Grundlage der
 *  Koexistenz-Regel (Spec §3). Beide Apps laden dieselbe entfernte Web-App,
 *  die Erkennung ist deshalb dieselbe wie ueberall sonst im Klienten. */
function eigenesGeraetDauerhaft(): boolean {
  return isElectron() || isCapacitorAndroid();
}

/** Unter diesem Vorrat wird nachgefuellt (s. `ONE_TIME_KEY_CAP = 100` im
 *  Server — 20 laesst reichlich Luft, bevor der Vorrat wirklich leer waere). */
const VORRAT_SCHWELLE = 20;
/** Wie viele Einmalschluessel auf einmal erzeugt werden. */
const NACHFUELL_BATCH = 30;

/** Legt das Buendel an oder ersetzt es — PUT ist idempotent, deshalb ohne
 *  vorherige Pruefung "ist es schon aktuell?" aufrufbar.
 *
 *  **Der erste Aufruf auf einem Geraet ist zugleich der Moment, in dem die
 *  Kennung dem Konto bekannt wird** (Spec §3b): `PUT /keys/bundle` ist eine
 *  der beiden Routen, die ein noch unbekanntes Geraet zulassen. Jede andere
 *  Krypto-Route dieses Geraets scheitert vorher mit 403. */
export async function veroeffentlicheSchluessel(): Promise<void> {
  let kennung: string;
  try {
    kennung = await geraeteKennung();
  } catch {
    // Noch keine Kennung (nicht angemeldet) — s. Modulkopf, best-effort.
    return;
  }

  // **Ganz vorn, vor jedem Zugriff auf eingefrorenen Zustand**: der
  // Pickle-Schluessel muss vom Ed25519-Anmeldeschluessel auf das
  // krypto-eigene Geheimnis wechseln, solange BEIDE existieren (Spec §3b,
  // „Reihenfolge"). Diese Funktion ist der Startweg jedes Klienten, und sie
  // laeuft, bevor ein Sende- oder Abholzyklus beginnt — die Stelle mit dem
  // kleinsten Fenster fuer einen zweiten Schreiber (s. `pickelUebergang.ts`).
  //
  // AUSSERHALB der Konto-Sperre unten, und das ist kein Versehen: Web Locks
  // sind nicht wiedereintrittsfaehig (`sperren.ts`, Regel 1), und der
  // Uebergang schreibt selbst in den Kontostand. Unter der Sperre wartete er
  // auf sich selbst.
  await pickelUebergangSicherstellen();

  // **Vor dem Veroeffentlichen**: ist dieses Geraet verfallen (Spec §3a), muss
  // sein lokaler Verlauf weg, bevor es sich wieder als Empfaenger meldet.
  // Diese Funktion ist der Startweg jedes Klienten (Login und
  // Cert-Rotation) — also genau das „naechste Oeffnen", von dem die Regel
  // spricht. Der Aufruf hat keinen Einfluss auf die Reihenfolge am Server
  // (der Grabstein klebt, s. `schluessel_verfall.py`); er steht hier, weil
  // hier der Ort ist, an dem ein Browser wieder aufwacht.
  await verfallPruefen();

  // **Unter der Konto-Sperre, und zwar ueber die Netzaufrufe hinweg**
  // (Bughunt 2026-08-29, s. `sperren.ts`). Diese Funktion laeuft beim Start
  // JEDES Tabs (`identity/cert-rotation.svelte.ts`), und der Krypto-Account
  // liegt im gemeinsamen IndexedDB des Browserprofils. Ohne Sperre: Tab A und
  // B laden denselben Kontostand, A erzeugt Einmalschluessel, sichert und
  // veroeffentlicht ihre OEFFENTLICHEN Haelften; B erzeugt aus seinem
  // veralteten Stand eigene und ueberschreibt A's Speicherstand. A's PRIVATE
  // Haelften sind damit weg, ihre oeffentlichen liegen weiter auf dem Server
  // — jeder Absender, der eine davon beansprucht, schreibt eine dauerhaft
  // unlesbare Nachricht.
  //
  // **Warum die Netzaufrufe hineingehoeren, obwohl sie die Sperre lange
  // halten koennen:** die Aussage, die geschuetzt werden muss, verbindet die
  // beiden Seiten — „zu jeder oeffentlichen Haelfte auf dem Server liegt die
  // private hier". Wuerde die Sperre vor `publishBundle`/`addOneTimeKeys`
  // fallen, koennte ein zweiter Tab genau waehrend der laufenden Anfrage
  // laden und sichern; der Schaden entstuende unveraendert. Die Sperre trifft
  // ausserdem nur, was sich wirklich widerspricht: Senden nimmt sie nicht
  // (es veraendert den Account nicht, s. `senden.ts`).
  await mitKontosperre(async () => {
    const ident = await kryptoAccountLaden();
    const rueckfallschluessel = await rueckfallschluesselSicherstellen(ident);

    await keysApi.publishBundle(
      {
        device_pubkey: kennung,
        curve25519: ident.curve25519(),
        rueckfallschluessel,
        dauerhaft: eigenesGeraetDauerhaft()
      },
      cloudRoute()
    );

    await nachfuellenWennNoetig(ident, kennung);
  });
}

async function nachfuellenWennNoetig(ident: Identitaet, kennung: string): Promise<void> {
  const { vorrat } = await keysApi.oneTimeKeyCount(kennung, cloudRoute());

  if (vorrat < VORRAT_SCHWELLE) {
    ident.einmalschluesselErzeugen(NACHFUELL_BATCH);
    await kryptoAccountSichern(ident);
  }

  // Alle noch unveroeffentlichten Schluessel holen, nicht nur die eben
  // erzeugten — das schliesst auch den Fall ein, dass ein frueherer Lauf
  // zwischen "erzeugen" und "als veroeffentlicht markieren" abgebrochen ist
  // (App-Crash, Tab-Schliessen): diese Schluessel bleiben sonst fuer immer
  // unveroeffentlicht, ohne dass es auffiele.
  const zuVeroeffentlichen = ident.offeneEinmalschluessel();
  if (zuVeroeffentlichen.length === 0) return;

  // Bughunt Runde 10: der Server lehnt einen Batch ab, der den Cap von 100
  // sprengt (vorhandene + len > 100 → 400). Offene Schlüssel aus
  // gescheiterten Läufen schrumpften nie (markiert wird erst nach Erfolg) —
  // ab ~4 gescheiterten Läufen war 0 + >100 > 100 und JEDE Nachfüllung für
  // immer tot: Vorrat leer, jeder neue Sitzungsaufbau lief über den nie
  // rotierten Fallback-Schlüssel.
  // Fix: auf den freien Platz kappen (Server nimmt max. diesen), NUR den
  // gekappten Batch hochladen. Das anschließende
  // `alsVeroeffentlichtMarkieren()` ist All-or-Nothing (vodozemac) und
  // verwirft die NICHT hochgeladenen Überschuss-Schlüssel — gewollt: sie
  // waren nie veröffentlicht, also wertlos, und die nächste Nachfüllung
  // erzeugt bei Bedarf frische.
  const freierPlatz = Math.max(0, 100 - vorrat);
  if (freierPlatz === 0) return;
  const batch = zuVeroeffentlichen.slice(0, freierPlatz);

  await keysApi.addOneTimeKeys(
    { device_pubkey: kennung, schluessel: batch },
    cloudRoute()
  );

  ident.alsVeroeffentlichtMarkieren();
  await kryptoAccountSichern(ident);
}

/**
 * **Bughunt Runde 36**: Nachfüllen im laufenden Betrieb. Bislang lief das
 * nur beim Start (`runIssueFlow`, „genau einmal pro Seitenleben") und bei
 * der Kopplung — der Vorrat (Cap 100 je Gerät) wurde aber bei JEDEM Claim
 * verbraucht, auch von jedem eingehenden Sitzungsaufbau. In einer
 * langlebigen Registerkarte war er nach ~100 empfangenen Nachrichten
 * dauerhaft leer, und jeder neue Sitzungsaufbau lief über den nie mehr
 * rotierten Fallback-Schlüssel — keine Forward Secrecy mehr je Sitzung,
 * herbeigeführt durch normalste Nutzung.
 *
 * Best-effort und stumm: Fehler (offline, nicht angemeldet) werden nur
 * geloggt — der nächste Postfach-Zyklus versucht es erneut. Ruft NUR
 * `nachfuellenWennNoetig` (kein `publishBundle`) und erwartet, bereits
 * unter der Konto-Sperre zu laufen (Aufrufer: `postfachZyklus`).
 */
export async function fuelleEinmalschluesselNach(): Promise<void> {
  let kennung: string;
  try {
    kennung = await geraeteKennung();
  } catch {
    return; // Nicht angemeldet — s. Modulkopf.
  }
  try {
    const ident = await kryptoAccountLaden();
    await nachfuellenWennNoetig(ident, kennung);
  } catch (err) {
    console.warn('[krypto] Einmalschluessel-Nachfüllen verschoben:', err);
  }
}
