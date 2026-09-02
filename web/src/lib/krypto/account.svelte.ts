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
 * **Keine Funktion in dieser Datei nimmt selbst eine Sperre** — das tut die
 * aufrufende Ablaufstelle (`veroeffentlichen.ts`, `empfangen.ts`), und zwar
 * ueber Laden UND Sichern zusammen. Zwei Gruende: eine Sperre nur ums
 * Sichern verhinderte nichts (der verlorene Stand entsteht schon beim
 * Laden), und Web Locks sind nicht wiedereintrittsfaehig — eine Sperre hier
 * wuerde unter der Sperre des Aufrufers auf sich selbst warten
 * (`sperren.ts`, Regel 1). Wer eine dieser Funktionen an einer NEUEN Stelle
 * ruft und dabei den Account veraendert, muss `mitKontosperre` selbst
 * mitbringen.
 *
 * Der Einfrier-Schluessel ist an ein Geheimnis gebunden, das dieses Geraet
 * nie verlassen kann (`extractable: false`). Wird es geloescht (Abmelden),
 * ist der eingefrorene Zustand absichtlich unlesbar (s. Plan-Etappe B2
 * Task 1) — deshalb wischt `auth.svelte.ts` es zusammen mit dem
 * Anmeldeschluessel.
 *
 * **WELCHES Geheimnis, entscheidet die Marke** (Spec §3b, Absatz
 * „Reihenfolge"): bis zum Uebergang eine Signatur des Ed25519-
 * Anmeldeschluessels, danach das krypto-eigene Geheimnis
 * (`geraeteGeheimnis.ts`). Der Anmeldeschluessel ist auf `main` ersatzlos
 * geloescht; der Uebergang (`pickelUebergang.ts`) muss deshalb laufen,
 * solange es ihn hier noch gibt. **Kein Rueckfall in die andere Richtung:**
 * bei gesetzter Marke ohne Geheimnis wird geworfen, nicht der alte Weg
 * versucht — wer raet und danach neu einfriert, hat den Zustand nicht
 * beschaedigt, sondern verloren.
 */
import init, { Identitaet } from '../../../../krypto/pulse-krypto/pkg/pulse_krypto.js';
import { openIdentityDb, idbGetIdentity, idbPutIdentity } from '../identity/idb-shared';
import { loadKeypair, signChallenge } from '../identity/keypair.svelte';
import { pickelgeheimnisLesen, pickelmarkeLesen } from './geraeteGeheimnis';
import { pickelschluesselAbleiten, pickelschluesselAusGeheimnis } from './pickelschluessel';
import { markeDeuten } from './pickelUebergangPlan';

/** Exportiert, weil `sitzungen.ts::sitzungMitKontoAtomarSichern` denselben
 *  Schluessel braucht — s. dort. */
export const IDB_KEY = 'pulse.krypto-account';
/** Cache des OEFFENTLICHEN Rueckfallschluessels, ausserhalb des Pickles —
 *  Begruendung an `rueckfallschluesselSicherstellen`. */
const IDB_KEY_RUECKFALLSCHLUESSEL = 'pulse.krypto-rueckfallschluessel';

/** Trennt diese Ableitung von jeder anderen Signatur, die derselbe
 *  Geraeteschluessel leistet (z. B. Cert-Login-Challenges). */
const PICKLE_KONTEXT = new TextEncoder().encode('pulse-krypto-pickle-v1');

let _wasmBereit: Promise<void> | null = null;

/** Initialisiert das WASM-Modul genau einmal, egal wie oft aufgerufen.
 *  Exportiert, weil `pickelUebergang.ts` vor dem Auf- und Wiedereinfrieren
 *  dieselbe Zusicherung braucht — eine zweite Einmal-Wache daneben waeren
 *  zwei Wachen fuer ein Modul, das genau einmal geladen werden darf. */
export async function sicherstellenWasm(): Promise<void> {
  if (!_wasmBereit) {
    _wasmBereit = init().then(() => undefined);
  }
  await _wasmBereit;
}

/** Der ALTE Weg: den festen Kontext mit dem Ed25519-Anmeldeschluessel
 *  signieren und daraus ableiten. `null`, wenn dieses Geraet keinen
 *  Anmeldeschluessel (mehr) hat — der Uebergang unterscheidet daran den
 *  Erstlauf eines frischen Geraets vom Totalverlust-Fall. */
export async function altpickelschluesselWennVorhanden(): Promise<Uint8Array | null> {
  const keypair = await loadKeypair();
  if (!keypair) return null;
  const signatur = await signChallenge(keypair, PICKLE_KONTEXT);
  return pickelschluesselAbleiten(signatur.buffer as ArrayBuffer);
}

/** Der 32-Byte-Schluessel, mit dem aller eingefrorene Zustand dieses Geraets
 *  auf- und zugeht — Konto, Olm-Sitzungen und Gruppensitzungen teilen ihn
 *  (s. Modulkopf; ein zweiter waere ein zweites Geheimnis ohne Gewinn).
 *
 *  Welche Quelle gilt, sagt die Marke — s. Modulkopf. Beide Fehlerfaelle
 *  werfen, keiner faellt auf die jeweils andere Quelle zurueck.
 *
 *  Exportiert, weil `sitzungen.ts` und `gruppe/gruppenSitzungen.ts` denselben
 *  Schluessel brauchen. */
export async function pickelschluesselDesGeraets(): Promise<Uint8Array> {
  const db = await openIdentityDb();
  const marke = markeDeuten(await pickelmarkeLesen(db));
  if (marke === 'schon_umgestellt') {
    const geheimnis = await pickelgeheimnisLesen(db);
    db.close();
    if (!geheimnis) {
      // Kein Rueckfall auf den alten Weg: die Marke sagt, dass mit dem NEUEN
      // Schluessel eingefroren wurde, und der alte oeffnet das nicht. Ein
      // Versuch waere ein Ratespiel um den ganzen lokalen Verlauf.
      throw new Error('PICKELGEHEIMNIS_FEHLT');
    }
    return pickelschluesselAusGeheimnis(geheimnis);
  }
  db.close();

  const alt = await altpickelschluesselWennVorhanden();
  if (!alt) throw new Error('KEIN_GERAETESCHLUESSEL');
  return alt;
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
 *
 * **Nur unter der Konto-Sperre aufrufen** (s. Modulkopf): Nachsehen, Erzeugen,
 * Sichern und Zwischenspeichern sind vier Schritte, und der erzeugte
 * Rueckfallschluessel ist zwischen Schritt zwei und vier nirgends dauerhaft
 * abgelegt. Der einzige Aufrufer ist `veroeffentlichen.ts`, der sie haelt.
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
