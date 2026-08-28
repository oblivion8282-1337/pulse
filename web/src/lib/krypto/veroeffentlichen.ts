/**
 * Veroeffentlicht das Schluessel-Buendel dieses Geraets und fuellt den
 * Einmalschluessel-Vorrat auf, wenn er zur Neige geht (E2E-DM Etappe B2).
 *
 * Rueckfallschluessel bleiben ausserhalb dieser Etappe: das Buendel traegt
 * das Feld, aber niemand befuellt es hier — der Server behandelt ein
 * fehlendes Feld korrekt (kein Rueckfallschluessel angeboten). Das Nachliefern
 * dieser Etappe deckt nur den Einmalschluessel-Vorrat ab.
 *
 * Best-effort ueberall: fehlt Geraeteschluessel oder Cert (noch nicht
 * angemeldet, Issue-Flow zuvor fehlgeschlagen), passiert nichts — die
 * Aufrufer (`runIssueFlow`, Cert-Rotation) fangen Fehler ohnehin ab und
 * versuchen es beim naechsten Anlauf erneut.
 */
import { certStore } from '../identity/cert.svelte';
import type { IdentityCert } from '../identity/cert.svelte';
import { loadKeypair, signChallenge } from '../identity/keypair.svelte';
import type { StoredKeypair } from '../identity/keypair.svelte';
import { keysApi } from '../api/keys';
import { kryptoAccountLaden, kryptoAccountSichern } from './account.svelte';
import { baueNutzlast } from './nutzlast';

/** Unter diesem Vorrat wird nachgefuellt (s. `ONE_TIME_KEY_CAP = 100` im
 *  Server — 20 laesst reichlich Luft, bevor der Vorrat wirklich leer waere). */
const VORRAT_SCHWELLE = 20;
/** Wie viele Einmalschluessel auf einmal erzeugt werden. */
const NACHFUELL_BATCH = 30;

type Identitaet = Awaited<ReturnType<typeof kryptoAccountLaden>>;

function base64UrlAusBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signiereNutzlast(keypair: StoredKeypair, nutzlast: Uint8Array): Promise<string> {
  const signatur = await signChallenge(keypair, nutzlast);
  return base64UrlAusBytes(signatur);
}

/** Legt das Buendel an oder ersetzt es — PUT ist idempotent, deshalb ohne
 *  vorherige Pruefung "ist es schon aktuell?" aufrufbar. Genau diese
 *  Unbedingtheit ist es, die die Cert-Rotation-Luecke schliesst: ein erneuter
 *  Aufruf nach neuem Cert schreibt die aktuelle `cert_id` nach. */
export async function veroeffentlicheSchluessel(): Promise<void> {
  const keypair = await loadKeypair();
  const cert = certStore.cert;
  if (!keypair || !cert) return;

  const ident = await kryptoAccountLaden();

  const buendelNutzlast = baueNutzlast('buendel', ident.curve25519(), '');
  const buendelSignatur = await signiereNutzlast(keypair, buendelNutzlast);
  await keysApi.publishBundle({
    cert: cert.raw,
    signatur: buendelSignatur,
    curve25519: ident.curve25519()
  });

  await nachfuellenWennNoetig(ident, keypair, cert);
}

async function nachfuellenWennNoetig(
  ident: Identitaet,
  keypair: StoredKeypair,
  cert: IdentityCert
): Promise<void> {
  const { vorrat } = await keysApi.oneTimeKeyCount(cert.claims.device_pubkey);

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
  await keysApi.addOneTimeKeys({ cert: cert.raw, signatur, schluessel: zuVeroeffentlichen });

  ident.alsVeroeffentlichtMarkieren();
  await kryptoAccountSichern(ident);
}
