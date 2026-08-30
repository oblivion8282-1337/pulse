/**
 * Das geraetelokale Material, das der KRYPTO-SCHICHT gehoert: das Geheimnis,
 * aus dem der Pickle-Schluessel abgeleitet wird, und die Marke, die sagt,
 * welche Quelle gilt.
 *
 * Beide liegen in derselben Identitaets-Datenbank wie der Olm-Account
 * (`pulse-identity`, s. `account.svelte.ts`-Modulkopf) — nicht in
 * `pulse-verlauf`: der Verlauf ist Nutzinhalt und muss getrennt loeschbar
 * bleiben, das Geheimnis gehoert zum Geraet.
 *
 * **Das Geheimnis ist `extractable: false`.** Es wird nur zum Ableiten
 * benutzt, nie ausgelesen; sein Rohwert verlaesst dieses Geraet damit auch
 * dann nicht, wenn jemand die IndexedDB als Ganzes ausliest. Genau diese
 * Eigenschaft hatte bisher der Ed25519-Anmeldeschluessel — sie wandert mit,
 * statt beim Umbau verloren zu gehen.
 *
 * **Es wird zusammen mit dem Anmeldeschluessel gewischt** (`auth.svelte.ts`,
 * beide Abmeldewege). Ohne das waere eine Nebenwirkung des Umbaus, dass ein
 * Abmelden den eingefrorenen Krypto-Zustand nicht mehr unlesbar macht — heute
 * tut es das, weil der Pickle-Schluessel am Anmeldeschluessel haengt, und
 * `account.svelte.ts` beruft sich ausdruecklich darauf. Der Umbau darf diese
 * Zusage nicht stillschweigend kassieren.
 */
import {
  openIdentityDb,
  idbGetIdentity,
  idbDeleteIdentity
} from '../identity/idb-shared';

/** Das Geheimnis selbst. */
export const IDB_KEY_PICKELGEHEIMNIS = 'pulse.krypto-pickelgeheimnis';
/** Welche Quelle gilt — s. `pickelUebergangPlan.ts::markeDeuten`. */
export const IDB_KEY_PICKELMARKE = 'pulse.krypto-pickelquelle';

/**
 * Erzeugt ein neues Geheimnis. Legt es NICHT ab — das tut der Uebergang, und
 * zwar in derselben Transaktion, in der er die Marke setzt
 * (`pickelUebergang.ts`). Ein Geheimnis ohne Marke waere ein harmloser
 * Waisenwert; eine Marke ohne Geheimnis waere der Totalverlust.
 */
export async function pickelgeheimnisErzeugen(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false, // extractable: false — s. Modulkopf
    ['sign']
  );
}

/** Liest das abgelegte Geheimnis — `undefined`, wenn es (noch) keines gibt. */
export async function pickelgeheimnisLesen(db: IDBDatabase): Promise<CryptoKey | undefined> {
  return (await idbGetIdentity(db, IDB_KEY_PICKELGEHEIMNIS)) as CryptoKey | undefined;
}

/** Liest die Marke roh — gedeutet wird sie in `pickelUebergangPlan.ts`. */
export async function pickelmarkeLesen(db: IDBDatabase): Promise<unknown> {
  return idbGetIdentity(db, IDB_KEY_PICKELMARKE);
}

/**
 * Loescht Geheimnis und Marke — der Abmeldeweg, parallel zu `wipeKeypair()`.
 *
 * Best-effort wie dort: ein Fehlschlag beim Wischen darf das Abmelden nicht
 * aufhalten. Die Reihenfolge ist trotzdem nicht beliebig — erst die Marke,
 * dann das Geheimnis: bliebe die Marke stehen, waehrend das Geheimnis weg
 * ist, verlangte der naechste Start einen Schluessel, den es nicht mehr gibt,
 * und wuerde mit `PICKELGEHEIMNIS_FEHLT` haengenbleiben, statt sich als
 * frisches Geraet zu verhalten.
 */
export async function geraeteGeheimnisWischen(): Promise<void> {
  try {
    const db = await openIdentityDb();
    await idbDeleteIdentity(db, IDB_KEY_PICKELMARKE);
    await idbDeleteIdentity(db, IDB_KEY_PICKELGEHEIMNIS);
    db.close();
  } catch {
    // Best-effort — wie `wipeKeypair()`.
  }
}
