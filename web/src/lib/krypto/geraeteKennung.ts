/**
 * Die eigene Geraetekennung — die EINE Stelle, an der der Klient sie
 * herleitet (Spec §3b, Punkt 1). Die Rechnung dahinter samt Begruendung
 * steht importfrei nebenan in `geraeteKennungWahl.ts`.
 *
 * **Was sich damit aendert:** bisher las jede Verwendungsstelle
 * `certStore.cert.claims.device_pubkey` selbst (`veroeffentlichen.ts`,
 * `verfallPruefen.ts`, `senden.ts` und `gruppe/senden.ts`, von dort weiter
 * in `empfaengerGeraete.ts` und `gruppe/gruppengeraete.ts`) — Stellen, die
 * alle umfallen, wenn das Zertifikat verschwindet. Jetzt lesen sie diese
 * eine Datei, die den Wert in der Identitaets-Datenbank ablegt und von dort
 * herausgibt. Solange es ein Zertifikat gibt, ist sein Wert massgeblich;
 * faellt es weg, traegt der abgelegte weiter. Der Import von `cert.svelte`
 * unten ist damit die einzige Zeile, die der spaetere Schnitt anfassen muss.
 *
 * **Der Wert bleibt derselbe wie bisher, und das ist keine Zwischenloesung
 * aus Bequemlichkeit:** die veroeffentlichten Schluesselbuendel des Servers
 * (`DeviceKeyBundle.device_pubkey`) und die Speicherschluessel aller
 * bestehenden Olm-Sitzungen (`sitzungsschluessel.ts`) haengen an ihm. Eine
 * neue Kennung waere kein Umzug, sondern ein zweites, leeres Geraet neben
 * dem eigenen.
 *
 * Sie wird zusammen mit Anmeldeschluessel und Zertifikat gewischt
 * (`auth.svelte.ts`) — sonst behielte der naechste Nutzer am selben Fenster
 * die Kennung des vorigen, waehrend der Server ihn unter einer neuen fuehrt.
 */
import { certStore } from '../identity/cert.svelte';
import {
  openIdentityDb,
  idbGetIdentity,
  idbPutIdentity,
  idbDeleteIdentity
} from '../identity/idb-shared';
import { kennungWaehlen } from './geraeteKennungWahl';

export const IDB_KEY_GERAETEKENNUNG = 'pulse.krypto-geraetekennung';

/**
 * Die Kennung dieses Geraets. Legt sie beim ersten Aufruf an und zieht sie
 * nach, wenn das Zertifikat einen anderen Wert traegt.
 *
 * Wirft `KEINE_GERAETEKENNUNG`, wenn weder etwas abgelegt ist noch ein
 * Zertifikat vorliegt. Die Aufrufer pruefen alle vorher auf ein Zertifikat
 * und kommen in diesem Zustand gar nicht erst hierher; der Wurf ist der
 * Riegel gegen eine kuenftige Stelle, die das vergisst — eine leere Kennung
 * waere ein Umschlag an niemanden.
 */
export async function geraeteKennung(): Promise<string> {
  const db = await openIdentityDb();
  const gespeichert = (await idbGetIdentity(db, IDB_KEY_GERAETEKENNUNG)) as string | undefined;
  const wahl = kennungWaehlen(gespeichert, certStore.cert?.claims.device_pubkey);
  if (wahl.schreiben) await idbPutIdentity(db, IDB_KEY_GERAETEKENNUNG, wahl.kennung);
  db.close();
  return wahl.kennung;
}

/** Loescht die abgelegte Kennung — der Abmeldeweg, parallel zu
 *  `wipeKeypair()`. Best-effort wie dort: ein Fehlschlag darf das Abmelden
 *  nicht aufhalten. */
export async function geraeteKennungWischen(): Promise<void> {
  try {
    const db = await openIdentityDb();
    await idbDeleteIdentity(db, IDB_KEY_GERAETEKENNUNG);
    db.close();
  } catch {
    // Best-effort — wie `wipeKeypair()`.
  }
}
