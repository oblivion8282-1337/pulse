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
 * **Ergaenzung aus demselben Bughunt (FIX 3):**
 * `mitSitzungssperre` — zwei gleichzeitige Operationen auf demselben
 * Sitzungsschluessel (z. B. zwei schnelle Sendungen, oder ein Empfang
 * waehrend eine Sendung laeuft) laden sonst dieselbe eingefrorene Sitzung,
 * ratcheten sie unabhaengig weiter und der letzte Schreiber gewinnt — der
 * andere Ratchet-Schritt ist weg, obwohl sein Umschlag schon zugestellt
 * wurde. Die eigentliche Warteschlangen-Rechnung steht importfrei in
 * `sitzungssperre.ts` (s. dort, CLAUDE.md „Die Falle" — dieses Modul hier
 * haengt am WASM-Paket und ist deshalb selbst nicht Node-pruefbar).
 */
import type { Identitaet, Sitzung } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { Sitzung as SitzungKlasse } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { STORE_NAME, openIdentityDb, idbGetIdentity, idbPutIdentity } from '../identity/idb-shared';
import { IDB_KEY as KONTO_IDB_KEY, pickelschluesselDesGeraets } from './account.svelte';
import { sitzungsSchluessel } from './sitzungsschluessel';
import { mitSchluesselsperre } from './sitzungssperre';

function idbSchluessel(kanalId: string, geraetePubkey: string): string {
  return `pulse.krypto-sitzung.${sitzungsSchluessel(kanalId, geraetePubkey)}`;
}

/** Laedt die eingefrorene Sitzung fuer dieses Geraetepaar — `null`, wenn
 *  noch keine besteht (dann muss `sitzungAusgehend`/`sitzungEingehend` eine
 *  neue anlegen). */
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
 * geraetePubkey) laufenden Aufgabe aus — nie gleichzeitig. Duennes
 * Wire-up um `mitSchluesselsperre` (s. dort fuer die eigentliche Rechnung
 * und die Begruendung).
 */
export function mitSitzungssperre<T>(
  kanalId: string,
  geraetePubkey: string,
  aufgabe: () => Promise<T>
): Promise<T> {
  return mitSchluesselsperre(sitzungsSchluessel(kanalId, geraetePubkey), aufgabe);
}
