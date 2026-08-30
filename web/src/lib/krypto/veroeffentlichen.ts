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
 * Best-effort ueberall: fehlt Geraeteschluessel oder Cert (noch nicht
 * angemeldet, Issue-Flow zuvor fehlgeschlagen), passiert nichts — die
 * Aufrufer (`runIssueFlow`, Cert-Rotation) fangen Fehler ohnehin ab und
 * versuchen es beim naechsten Anlauf erneut.
 */
import type { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { certStore } from '../identity/cert.svelte';
import type { IdentityCert } from '../identity/cert.svelte';
import { loadKeypair } from '../identity/keypair.svelte';
import type { StoredKeypair } from '../identity/keypair.svelte';
import { keysApi } from '../api/keys';
import { serversStore } from '../api/servers.svelte';
import { isElectron, isCapacitorAndroid } from '../platform/runtime';
import {
  kryptoAccountLaden,
  kryptoAccountSichern,
  rueckfallschluesselSicherstellen
} from './account.svelte';
import { geraeteKennung } from './geraeteKennung';
import { baueNutzlast } from './nutzlast';
import { signiereNutzlast } from './nachweis';
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
 *  vorherige Pruefung "ist es schon aktuell?" aufrufbar. Genau diese
 *  Unbedingtheit ist es, die die Cert-Rotation-Luecke schliesst: ein erneuter
 *  Aufruf nach neuem Cert schreibt die aktuelle `cert_id` nach. */
export async function veroeffentlicheSchluessel(): Promise<void> {
  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) return;

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

    const buendelNutzlast = baueNutzlast('buendel', ident.curve25519(), rueckfallschluessel);
    const buendelSignatur = await signiereNutzlast(keypair, buendelNutzlast);
    await keysApi.publishBundle(
      {
        cert: cert.raw,
        signatur: buendelSignatur,
        curve25519: ident.curve25519(),
        rueckfallschluessel,
        dauerhaft: eigenesGeraetDauerhaft()
      },
      cloudRoute()
    );

    await nachfuellenWennNoetig(ident, keypair, cert);
  });
}

async function nachfuellenWennNoetig(
  ident: Identitaet,
  keypair: StoredKeypair,
  cert: IdentityCert
): Promise<void> {
  const { vorrat } = await keysApi.oneTimeKeyCount(await geraeteKennung(), cloudRoute());

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

  const nutzlast = baueNutzlast('einmalschluessel', ...zuVeroeffentlichen);
  const signatur = await signiereNutzlast(keypair, nutzlast);
  await keysApi.addOneTimeKeys(
    { cert: cert.raw, signatur, schluessel: zuVeroeffentlichen },
    cloudRoute()
  );

  ident.alsVeroeffentlichtMarkieren();
  await kryptoAccountSichern(ident);
}
