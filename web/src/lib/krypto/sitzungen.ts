/**
 * Laedt/sichert Olm-Sitzungen — je Geraetepaar eine eingefrorene Zeile, in
 * derselben IndexedDB wie der Account (`pulse-identity`), unter eigenen
 * Schluesseln; derselbe Pickle-Schluessel wie beim Account
 * (`pickelschluesselDesGeraets` aus `account.svelte.ts`).
 *
 * **Die Falle, die alles kostet:** wird eine Sitzung nach dem Ver- oder
 * Entschluesseln nicht gesichert, laeuft ihr Zustand auseinander — die
 * naechste Nachricht ist dann nicht mehr zu oeffnen, ENDGUELTIG, weil der
 * Server keine Kopie hat. `sitzungSichern` ist deshalb Teil jeder Ver-/
 * Entschluesselung, kein Aufraeumen danach (s. `senden.ts`/`empfangen.ts`:
 * beide rufen es VOR jedem Netzwerk-Aufruf, der den neuen Zustand
 * unwiederbringlich macht — ein Umschlag, der raus ist, kann nicht mehr
 * zurueckgeholt werden).
 *
 * **Ergaenzung aus dem Bughunt vom 2026-08-28 (FIX 2):**
 * `sitzungMitKontoAtomarSichern` — der Sitzungsaufbau auf der Empfangsseite
 * (`ident.sitzungEingehend`) verbraucht einen Einmalschluessel AUF DEM
 * ACCOUNT (`&mut self`, s. `identitaet.rs`). Wird der Account gesichert und
 * schlaegt das Sichern der Sitzung danach fehl (oder umgekehrt), ist der
 * Einmalschluessel vom Account verschwunden, waehrend die Sitzung nirgends
 * liegt — die noch unquittierte Zustellung kommt beim naechsten Versuch
 * zurueck und ist dann NIE MEHR zu oeffnen. Beide Pickles muessen deshalb in
 * EINER IndexedDB-Transaktion landen, nicht in zwei nacheinander.
 *
 * **Ergaenzung aus demselben Bughunt (FIX 3), nachgeschaerft am 2026-08-29:**
 * `mitSitzungssperre` — zwei gleichzeitige Operationen auf demselben
 * Sitzungsschluessel (z. B. zwei schnelle Sendungen, oder ein Empfang
 * waehrend eine Sendung laeuft) laden sonst dieselbe eingefrorene Sitzung,
 * ratcheten sie unabhaengig weiter und der letzte Schreiber gewinnt — der
 * andere Ratchet-Schritt ist weg, obwohl sein Umschlag schon zugestellt
 * wurde. Die erste Fassung sperrte in einer Modul-`Map` und damit nur
 * innerhalb EINES Tabs; die IndexedDB darunter gehoert aber dem
 * Browserprofil. Die Sperre liegt jetzt auf `navigator.locks` und gilt je
 * Herkunft — Rechnung, Begruendung und die beiden Regeln (keine
 * Wiedereintritte, feste Erwerbsreihenfolge) stehen importfrei in
 * `sperren.ts` (CLAUDE.md „Die Falle" — dieses Modul hier haengt am
 * WASM-Paket und ist deshalb selbst nicht Node-pruefbar).
 */
import type { Identitaet, Sitzung } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { Sitzung as SitzungKlasse } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { STORE_NAME, openIdentityDb, idbGetIdentity, idbPutIdentity } from '../identity/idb-shared';
import { IDB_KEY as KONTO_IDB_KEY, pickelschluesselDesGeraets } from './account.svelte';
import { sitzungsSchluessel } from './sitzungsschluessel';
import { mitSchluesselsperre } from './sperren';

function idbSchluessel(kanalId: string, geraetePubkey: string): string {
  return `pulse.krypto-sitzung.${sitzungsSchluessel(kanalId, geraetePubkey)}`;
}

/** Laedt die eingefrorene Sitzung fuer dieses Geraetepaar — `null`, wenn
 *  noch keine besteht (dann muss `sitzungAusgehend`/`sitzungEingehend` eine
 *  neue anlegen). */
/**
 * Der Identitaetsschluessel (curve25519) der Gegenseite, fuer den die
 * gespeicherte Sitzung gebaut wurde. Kein Geheimnis — er steht im
 * veroeffentlichten Buendel —, deshalb ungefroren daneben.
 *
 * **Wozu (2026-09-03):** startet die Gegenseite frisch (neues Olm-Konto,
 * gleiche Geraetekennung), gilt die gespeicherte Sitzung nicht mehr. Ohne
 * diesen Vergleich schickte der Absender weiter laufende Umschlaege (Art 1)
 * in eine Sitzung, die es druben nicht mehr gibt — „keine Sitzung", jede
 * Nachricht, ohne Ausweg fuer den Empfaenger. Der Vergleich beim Senden
 * (`senden.ts`) erkennt den Wechsel am Buendel und baut neu auf.
 */
function idbPartnerSchluessel(kanalId: string, geraetePubkey: string): string {
  return `pulse.krypto-partner.${sitzungsSchluessel(kanalId, geraetePubkey)}`;
}

export async function partnerSchluesselLesen(
  kanalId: string,
  geraetePubkey: string
): Promise<string | null> {
  const db = await openIdentityDb();
  const wert = (await idbGetIdentity(db, idbPartnerSchluessel(kanalId, geraetePubkey))) as
    | string
    | undefined;
  db.close();
  return wert ?? null;
}

export async function partnerSchluesselMerken(
  kanalId: string,
  geraetePubkey: string,
  curve25519: string
): Promise<void> {
  const db = await openIdentityDb();
  await idbPutIdentity(db, idbPartnerSchluessel(kanalId, geraetePubkey), curve25519);
  db.close();
}

export async function sitzungLaden(
  kanalId: string,
  geraetePubkey: string
): Promise<Sitzung | null> {
  const schluessel = await pickelschluesselDesGeraets();
  const db = await openIdentityDb();
  const gefroren = (await idbGetIdentity(db, idbSchluessel(kanalId, geraetePubkey))) as
    | string
    | undefined;
  db.close();
  if (!gefroren) return null;
  return SitzungKlasse.auftauen(gefroren, schluessel);
}

/** Friert eine Sitzung ein und schreibt sie nach IndexedDB. MUSS nach JEDER
 *  zustandsaendernden Handlung aufgerufen werden — s. Modulkopf. */
export async function sitzungSichern(
  kanalId: string,
  geraetePubkey: string,
  sitzung: Sitzung
): Promise<void> {
  const schluessel = await pickelschluesselDesGeraets();
  const gefroren = sitzung.einfrieren(schluessel);
  const db = await openIdentityDb();
  await idbPutIdentity(db, idbSchluessel(kanalId, geraetePubkey), gefroren);
  db.close();
}

/**
 * Sichert Konto UND Sitzung in EINER IndexedDB-Transaktion — fuer den
 * eingehenden Sitzungsaufbau, der einen Einmalschluessel auf dem Account
 * verbraucht (s. Modulkopf). Landen beide oder keins: ein Fehlschlag lehnt
 * die ganze Transaktion ab, der Account bleibt beim alten (mit dem
 * Einmalschluessel noch offen), die Zustellung bleibt unquittiert und ein
 * spaeterer Versuch kann sie erneut oeffnen.
 */
export async function sitzungMitKontoAtomarSichern(
  ident: Identitaet,
  kanalId: string,
  geraetePubkey: string,
  sitzung: Sitzung
): Promise<void> {
  const schluessel = await pickelschluesselDesGeraets();
  const kontoGefroren = ident.einfrieren(schluessel);
  const sitzungGefroren = sitzung.einfrieren(schluessel);
  const db = await openIdentityDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(kontoGefroren, KONTO_IDB_KEY);
    tx.objectStore(STORE_NAME).put(sitzungGefroren, idbSchluessel(kanalId, geraetePubkey));
    // Wie `idbPutIdentity`: auf den durchgängigen Commit warten, nicht auf
    // den ersten `onsuccess` — s. Begründung dort.
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
  db.close();
}

/**
 * Fuehrt `aufgabe` streng NACH jeder anderen, fuer denselben (kanalId,
 * geraetePubkey) laufenden Aufgabe aus — nie gleichzeitig, und das ueber alle
 * Tabs derselben Herkunft. Duennes Wire-up um `mitSchluesselsperre`
 * (s. `sperren.ts` fuer den Mechanismus und die Begruendung).
 */
export function mitSitzungssperre<T>(
  kanalId: string,
  geraetePubkey: string,
  aufgabe: () => Promise<T>
): Promise<T> {
  return mitSchluesselsperre(sitzungsSchluessel(kanalId, geraetePubkey), aufgabe);
}
