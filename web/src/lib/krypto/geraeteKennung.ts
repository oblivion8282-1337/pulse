/**
 * Die eigene Geraetekennung — die EINE Stelle, an der der Klient sie
 * herleitet (Spec §3b, Punkt 1). Die Rechnung dahinter samt Begruendung
 * steht importfrei nebenan in `geraeteKennungWahl.ts`.
 *
 * **Was sich damit aendert:** bisher las jede Verwendungsstelle
 * `certStore.cert.claims.device_pubkey` selbst (`veroeffentlichen.ts`,
 * `verfallPruefen.ts`, `senden.ts` und `gruppe/senden.ts`, von dort weiter
 * in `empfaengerGeraete.ts` und `gruppe/gruppengeraete.ts`) — Stellen, die
 * alle umgefallen waeren, als das Zertifikat verschwand. Jetzt lesen sie
 * diese eine Datei, die den Wert in der Identitaets-Datenbank ablegt und von
 * dort herausgibt.
 *
 * **Der Schnitt ist inzwischen erfolgt.** Zertifikate gibt es seit dem
 * Weg-A-Umbau nicht mehr (Cloud-Tickets haben sie abgeloest); massgeblich ist
 * hier der oeffentliche Teil des Geraete-Schluesselpaars
 * (`identity/keypair.svelte.ts`), und der abgelegte Wert traegt weiter, wenn
 * gerade kein Schluesselpaar geladen ist. Die Kommentare dieser Datei sprachen
 * bis zum 2026-08-31 weiter vom Zertifikat, obwohl der Code es schon nicht
 * mehr las — dieselbe Sorte veralteter Behauptung, die den E2E-Test
 * `krypto-veroeffentlichen.spec.ts` einen Fehlalarm melden liess.
 *
 * **Der Wert bleibt derselbe wie bisher, und das ist keine Zwischenloesung
 * aus Bequemlichkeit:** die veroeffentlichten Schluesselbuendel des Servers
 * (`DeviceKeyBundle.device_pubkey`) und die Speicherschluessel aller
 * bestehenden Olm-Sitzungen (`sitzungsschluessel.ts`) haengen an ihm. Eine
 * neue Kennung waere kein Umzug, sondern ein zweites, leeres Geraet neben
 * dem eigenen.
 *
 * Sie wird zusammen mit dem Anmeldeschluessel gewischt
 * (`auth.svelte.ts`) — sonst behielte der naechste Nutzer am selben Fenster
 * die Kennung des vorigen, waehrend der Server ihn unter einer neuen fuehrt.
 */
import { loadKeypair, exportPublicKey } from '../identity/keypair.svelte';
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
 * nach, wenn das Geraete-Schluesselpaar einen anderen Wert traegt.
 *
 * Wirft `KEINE_GERAETEKENNUNG`, wenn weder etwas abgelegt ist noch ein
 * Schluesselpaar geladen werden kann. Der Wurf ist der Riegel gegen eine
 * Stelle, die ohne beides hierherkommt — eine leere Kennung waere ein
 * Umschlag an niemanden.
 */
export async function geraeteKennung(): Promise<string> {
  const db = await openIdentityDb();
  const gespeichert = (await idbGetIdentity(db, IDB_KEY_GERAETEKENNUNG)) as string | undefined;
  const schluessel = await loadKeypair();
  const eigenerPubkey = schluessel === null ? null : await exportPublicKey(schluessel);
  const wahl = kennungWaehlen(gespeichert, eigenerPubkey ?? undefined);
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
