/**
 * Laedt/erzeugt den vodozemac-Account dieses Geraets und friert ihn nach
 * jeder zustandsaendernden Handlung wieder ein.
 *
 * Speicherort: die BESTEHENDE Identitaets-Datenbank (`pulse-identity`, Store
 * `identity`, `idb-shared.ts`) unter dem neuen Schluessel `pulse.krypto-account`
 * — kein `DB_VERSION`-Sprung noetig, der Store hat keinen `keyPath` und nimmt
 * beliebige Schluessel. NICHT `pulse-verlauf`: der Verlauf ist Nutzinhalt und
 * muss getrennt loeschbar bleiben, der Account gehoert zum Geraeteschluessel.
 *
 * Der Einfrier-Schluessel kommt aus `pickelschluesselAbleiten` ueber eine
 * Signatur des Geraeteschluessels (`keypairStore`, `extractable: false`) —
 * der eingefrorene Zustand ist damit an ein Geheimnis gebunden, das dieses
 * Geraet nie verlassen kann. Wird der Geraeteschluessel geloescht (Abmelden),
 * ist der eingefrorene Zustand absichtlich unlesbar (s. Plan-Etappe B2 Task 1).
 */
import init, { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { openIdentityDb, idbGetIdentity, idbPutIdentity } from '../identity/idb-shared';
import { loadKeypair, signChallenge } from '../identity/keypair.svelte';
import { pickelschluesselAbleiten } from './pickelschluessel';

const IDB_KEY = 'pulse.krypto-account';
/** Cache des OEFFENTLICHEN Rueckfallschluessels, ausserhalb des Pickles —
 *  Begruendung an `rueckfallschluesselSicherstellen`. */
const IDB_KEY_RUECKFALLSCHLUESSEL = 'pulse.krypto-rueckfallschluessel';

/** Trennt diese Ableitung von jeder anderen Signatur, die derselbe
 *  Geraeteschluessel leistet (z. B. Cert-Login-Challenges). */
const PICKLE_KONTEXT = new TextEncoder().encode('pulse-krypto-pickle-v1');

let _wasmBereit: Promise<void> | null = null;

/** Initialisiert das WASM-Modul genau einmal, egal wie oft aufgerufen. */
async function sicherstellenWasm(): Promise<void> {
  if (!_wasmBereit) {
    _wasmBereit = init().then(() => undefined);
  }
  await _wasmBereit;
}

/** Signiert den festen Kontext mit dem Geraeteschluessel und leitet daraus
 *  den 32-Byte-Pickle-Schluessel ab. Wirft, wenn (noch) kein Geraeteschluessel
 *  geladen ist — ohne ihn kann weder eingefroren noch aufgetaut werden.
 *
 *  Exportiert, weil `sitzungen.ts` denselben Schluessel braucht (Olm-
 *  Sitzungen liegen im selben Store, s. Modulkopf) — ein zweiter, eigener
 *  Pickle-Schluessel wuerde nur ein zweites Geheimnis pflegen, ohne Gewinn. */
export async function pickelschluesselDesGeraets(): Promise<Uint8Array> {
  const keypair = await loadKeypair();
  if (!keypair) {
    throw new Error('KEIN_GERAETESCHLUESSEL');
  }
  const signatur = await signChallenge(keypair, PICKLE_KONTEXT);
  return pickelschluesselAbleiten(signatur.buffer as ArrayBuffer);
}

/**
 * Laedt den eingefrorenen Account aus IndexedDB und taut ihn auf — oder legt
 * beim allerersten Aufruf einen neuen an und friert ihn sofort ein.
 */
export async function kryptoAccountLaden(): Promise<Identitaet> {
  await sicherstellenWasm();
  const schluessel = await pickelschluesselDesGeraets();

  const db = await openIdentityDb();
  const gefroren = (await idbGetIdentity(db, IDB_KEY)) as string | undefined;
  db.close();

  if (gefroren) {
    // Absichtlich KEIN Fallback auf "neu anlegen" bei einem Fehlschlag hier:
    // ein falscher Schluessel oder ein beschaedigter Zustand sieht sonst wie
    // ein Erstlauf aus, und ein still neu angelegter Account verwirft die
    // Sitzungen, die der Nutzer eigentlich noch lesen koennen muesste.
    return Identitaet.auftauen(gefroren, schluessel);
  }

  const ident = new Identitaet();
  await kryptoAccountSichern(ident);
  return ident;
}

/**
 * Friert den Account ein und schreibt ihn nach IndexedDB. MUSS nach JEDER
 * zustandsaendernden Handlung aufgerufen werden — `einmalschluesselErzeugen`,
 * `alsVeroeffentlichtMarkieren`, jeder Sitzungsaufbau. Ohne diesen Aufruf
 * sind veroeffentlichte Einmalschluessel nach einem Neustart wieder "offen",
 * und eine Nachricht an dieses Geraet wird unlesbar, ohne dass irgendwo ein
 * Fehler erscheint.
 */
export async function kryptoAccountSichern(ident: Identitaet): Promise<void> {
  const schluessel = await pickelschluesselDesGeraets();
  const gefroren = ident.einfrieren(schluessel);
  const db = await openIdentityDb();
  await idbPutIdentity(db, IDB_KEY, gefroren);
  db.close();
}

/**
 * Liefert den oeffentlichen Rueckfallschluessel dieses Geraets — erzeugt ihn
 * beim allerersten Aufruf, danach immer denselben.
 *
 * **Warum ein eigener Cache, statt bei jedem Aufruf frisch zu fragen:**
 * vodozemacs `Account::fallback_key()` (hinter `rueckfallschluesselErzeugen`,
 * s. Doc-Kommentar dort) liefert einen Schluessel nur, solange er nicht als
 * veroeffentlicht markiert ist. `veroeffentlicheSchluessel` markiert aber im
 * selben Lauf die Einmalschluessel als veroeffentlicht — und
 * `mark_keys_as_published()` markiert BEIDES, Einmalschluessel UND
 * Rueckfallschluessel, in einem Aufruf. Ohne diesen Cache waere der
 * Rueckfallschluessel schon beim naechsten Aufruf von
 * `veroeffentlicheSchluessel` (naechster Login, naechste Cert-Rotation)
 * nicht mehr abrufbar — `PUT /keys/bundle` ist ein voller Zeilen-Ersatz
 * (s. `schluessel.py`), ein fehlendes Feld ueberschreibt den zuvor
 * gespeicherten Rueckfallschluessel mit NULL.
 *
 * Ein `generate_fallback_key()` bei jedem Aufruf waere die falsche
 * Alternative: es ERSETZT den aktuellen Rueckfallschluessel unbedingt
 * (echte Rotation), was bei jedem Login/jeder Cert-Rotation unnoetig waere.
 */
export async function rueckfallschluesselSicherstellen(ident: Identitaet): Promise<string> {
  const db = await openIdentityDb();
  const gecacht = (await idbGetIdentity(db, IDB_KEY_RUECKFALLSCHLUESSEL)) as string | undefined;
  if (gecacht) {
    db.close();
    return gecacht;
  }

  const neu = ident.rueckfallschluesselErzeugen();
  if (!neu) {
    // Laut vodozemac-Semantik kann ein Aufruf, der wirklich generiert hat,
    // nicht leer zurueckkommen (s. Rust-Doc-Kommentar an der Funktion) —
    // dieser Zweig ist eine Absicherung gegen eine kuenftige Aenderung dort,
    // kein erwarteter Pfad.
    db.close();
    throw new Error('RUECKFALLSCHLUESSEL_FEHLGESCHLAGEN');
  }

  // Mutiert den Account — MUSS gesichert werden, s. Doc-Kommentar oben an
  // `kryptoAccountSichern`.
  await kryptoAccountSichern(ident);
  await idbPutIdentity(db, IDB_KEY_RUECKFALLSCHLUESSEL, neu);
  db.close();
  return neu;
}
