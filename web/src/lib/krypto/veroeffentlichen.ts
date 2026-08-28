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
import { baueNutzlast } from './nutzlast';
import { signiereNutzlast } from './nachweis';

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
}

async function nachfuellenWennNoetig(
  ident: Identitaet,
  keypair: StoredKeypair,
  cert: IdentityCert
): Promise<void> {
  const { vorrat } = await keysApi.oneTimeKeyCount(cert.claims.device_pubkey, cloudRoute());

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
