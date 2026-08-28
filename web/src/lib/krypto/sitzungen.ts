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
 */
import type { Sitzung } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { Sitzung as SitzungKlasse } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { openIdentityDb, idbGetIdentity, idbPutIdentity } from '../identity/idb-shared';
import { pickelschluesselDesGeraets } from './account.svelte';
import { sitzungsSchluessel } from './sitzungsschluessel';

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
