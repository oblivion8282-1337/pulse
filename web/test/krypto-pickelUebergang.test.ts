import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MARKE_KRYPTOGEHEIMNIS,
  markeDeuten,
  pickleartVon,
  umschreibenPlanen
} from '../src/lib/krypto/pickelUebergangPlan.ts';

/**
 * Der Uebergang des Pickle-Schluessels vom Ed25519-Anmeldeschluessel auf ein
 * krypto-eigenes Geheimnis (Spec §3b, „Reihenfolge").
 *
 * **Warum diese Datei die teuerste Gegenprobe im Baum ist:** geht der
 * Uebergang schief, ist der eingefrorene Olm-Zustand nicht beschaedigt,
 * sondern UNLESBAR — und der Server haelt keine Kopie. Es gibt keinen
 * zweiten Versuch und keine Reparatur, nur den Verlust. Geprueft wird
 * deshalb nicht „laeuft durch", sondern die zwei Zusagen, an denen alles
 * haengt: was mit dem ALTEN Schluessel eingefroren wurde, ist danach mit dem
 * NEUEN aufzutauen — und ein Fehlschlag schreibt NICHTS.
 *
 * Die reine Rechnung steht importfrei in `pickelUebergangPlan.ts` (s.
 * CLAUDE.md „Die Falle"); die IndexedDB-Verkabelung darum herum
 * (`pickelUebergang.ts`) sieht Nodes Laeufer nicht. Was er dafuer sehr wohl
 * sieht, ist der Krypto-Kern selbst — das WASM-Paket laesst sich hier laden
 * (Muster: `krypto-wasm.test.ts`), und damit wird hier mit ECHTEN Pickles
 * gerechnet statt mit Attrappen.
 */

const pfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto.js', import.meta.url);
const wasmPfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto_bg.wasm', import.meta.url);

// Bewusst ungetypt und mit Ueberspring-Grund statt hartem Import — das Paket
// ist ein Bauergebnis und liegt nicht im Repo (Begruendung in voller Laenge
// im Kopf von `krypto-wasm.test.ts`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modul: any = null;
let fehlgrund = '';
try {
  modul = await import(pfad.href);
  await modul.default(await readFile(wasmPfad));
} catch (fehler) {
  modul = null;
  fehlgrund =
    'WASM-Paket nicht gebaut — `bash krypto/pulse-krypto/bauen-wasm.sh` ' +
    `ausfuehren. (${(fehler as Error).message})`;
}
const wennGebaut = fehlgrund ? { skip: fehlgrund } : {};

const ALT = new Uint8Array(32).fill(7);
const NEU = new Uint8Array(32).fill(9);

/** Dasselbe Umfrieren, das `pickelUebergang.ts` der Planung mitgibt — hier
 *  mit den echten WASM-Klassen. */
function umfrieren(art: string, gefroren: string): string {
  if (art === 'konto') return modul.Identitaet.auftauen(gefroren, ALT).einfrieren(NEU);
  if (art === 'sitzung') return modul.Sitzung.auftauen(gefroren, ALT).einfrieren(NEU);
  if (art === 'gruppensitzung')
    return modul.Gruppensitzung.auftauen(gefroren, ALT).einfrieren(NEU);
  return modul.Gruppenempfang.auftauen(gefroren, ALT).einfrieren(NEU);
}

// ---------------------------------------------------------------------------
// Die Marke — sie allein entscheidet, welcher Schluessel gilt
// ---------------------------------------------------------------------------

test('ohne Marke gilt der Zustand als noch nicht umgestellt', () => {
  assert.equal(markeDeuten(undefined), 'offen');
  assert.equal(markeDeuten(null), 'offen');
});

test('die gesetzte Marke schaltet auf den neuen Schluessel', () => {
  assert.equal(markeDeuten(MARKE_KRYPTOGEHEIMNIS), 'schon_umgestellt');
});

test('eine unbekannte Marke wird NICHT geraten, sondern geworfen', () => {
  // Der Kern der Fail-Safe-Regel: „unklar, womit eingefroren wurde" darf nie
  // in einen Versuch muenden. Ein Ratewert waere hier mit 50 % Wahr-
  // scheinlichkeit ein stiller Totalverlust.
  assert.throws(() => markeDeuten('kryptogeheimnis-v2'), /PICKELMARKE_UNBEKANNT/);
  assert.throws(() => markeDeuten(42), /PICKELMARKE_UNBEKANNT/);
});

// ---------------------------------------------------------------------------
// Welche Eintraege ueberhaupt umgefroren werden muessen
// ---------------------------------------------------------------------------

test('alle vier Pickle-Familien werden erkannt', () => {
  // Sie haengen alle am selben Schluessel (`sitzungen.ts`,
  // `gruppe/gruppenSitzungen.ts`) und muessen deshalb gemeinsam wandern.
  assert.equal(pickleartVon('pulse.krypto-account'), 'konto');
  assert.equal(pickleartVon('pulse.krypto-sitzung.42:ABC'), 'sitzung');
  assert.equal(pickleartVon('pulse.krypto-gruppensitzung.42'), 'gruppensitzung');
  assert.equal(pickleartVon('pulse.krypto-gruppenempfang.42.ABC.s1'), 'gruppenempfang');
});

test('was kein Pickle ist, bleibt unangetastet', () => {
  // Insbesondere der Rueckfallschluessel (blanker Base64-Text) und das neue
  // Geheimnis selbst (ein CryptoKey): beide durch das Umfrieren zu schicken
  // wuerde sie zerstoeren.
  assert.equal(pickleartVon('pulse.keypair'), null);
  assert.equal(pickleartVon('pulse.identity-cert'), null);
  assert.equal(pickleartVon('pulse.krypto-rueckfallschluessel'), null);
  assert.equal(pickleartVon('pulse.krypto-pickelgeheimnis'), null);
  assert.equal(pickleartVon('pulse.krypto-geraetekennung'), null);
});

// ---------------------------------------------------------------------------
// Die Zusage: mit ALT eingefroren, nach dem Uebergang mit NEU aufzutauen
// ---------------------------------------------------------------------------

test('ein mit dem ALTEN Schluessel eingefrorener Zustand ist danach auftaubar', wennGebaut, () => {
  const ident = new modul.Identitaet();
  ident.einmalschluesselErzeugen(2);
  const curveVorher = ident.curve25519();
  const ed25519Vorher = ident.ed25519();
  const offeneVorher = ident.offeneEinmalschluessel();

  const eintraege = [{ schluessel: 'pulse.krypto-account', wert: ident.einfrieren(ALT) }];
  const plan = umschreibenPlanen(eintraege, umfrieren);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].schluessel, 'pulse.krypto-account');

  // Der eigentliche Beweis: mit dem NEUEN Schluessel aufmachen — und es ist
  // derselbe Account, nicht bloss irgendeiner. Waere hier still ein neuer
  // angelegt worden, waeren Identitaet UND die noch offenen Einmalschluessel
  // andere, und jede an dieses Geraet unterwegs befindliche Nachricht waere
  // unlesbar.
  const wieder = modul.Identitaet.auftauen(plan[0].wert as string, NEU);
  assert.equal(wieder.curve25519(), curveVorher);
  assert.equal(wieder.ed25519(), ed25519Vorher);
  assert.deepEqual(wieder.offeneEinmalschluessel(), offeneVorher);

  // Und der ALTE Schluessel oeffnet ihn danach nicht mehr — sonst waere der
  // Uebergang nur behauptet.
  assert.throws(() => modul.Identitaet.auftauen(plan[0].wert as string, ALT));
});

test('auch Olm-Sitzungen wandern mit — sonst ist der Verlauf halb tot', wennGebaut, () => {
  // Eine Sitzung, die nicht mitwandert, sieht nach dem Uebergang wie ein
  // beschaedigter Eintrag aus: der Ratchet-Stand ist weg, und Megolm/Olm
  // laufen nur vorwaerts.
  const alice = new modul.Identitaet();
  const bob = new modul.Identitaet();
  const einmal = bob.einmalschluesselErzeugen(1);
  const sitzung = alice.sitzungAusgehend(bob.curve25519(), einmal[0]);
  const kennungVorher = sitzung.kennung();

  const plan = umschreibenPlanen(
    [{ schluessel: 'pulse.krypto-sitzung.42:ABC', wert: sitzung.einfrieren(ALT) }],
    umfrieren
  );
  const wieder = modul.Sitzung.auftauen(plan[0].wert as string, NEU);
  assert.equal(wieder.kennung(), kennungVorher);
});

test('die ausgehende Gruppensitzung behaelt ihre Buchhaltung', wennGebaut, () => {
  // Sie liegt als OBJEKT im Speicher (`gefroren` plus Buchhaltung, s.
  // `gruppe/gruppenSitzungen.ts`), nicht als blanke Zeichenkette. Wer das
  // uebersieht, schreibt den Pickle an die Stelle des ganzen Objekts und
  // verliert `sitzungId`/`beliefert` — die Sitzung wuerde danach fuer
  // niemanden mehr als beliefert gelten.
  const gs = new modul.Gruppensitzung();
  const verteil = gs.verteilschluessel();
  const stand = {
    sitzungId: 's1',
    gefroren: gs.einfrieren(ALT),
    mitglieder: ['u1'],
    beliefert: ['ABC'],
    nachrichten: 3,
    angelegtAm: 1000
  };

  const plan = umschreibenPlanen(
    [{ schluessel: 'pulse.krypto-gruppensitzung.42', wert: stand }],
    umfrieren
  );
  const neu = plan[0].wert as typeof stand;
  assert.equal(neu.sitzungId, 's1');
  assert.deepEqual(neu.beliefert, ['ABC']);
  assert.equal(neu.nachrichten, 3);
  assert.equal(modul.Gruppensitzung.auftauen(neu.gefroren, NEU).verteilschluessel(), verteil);
});

test('eingehende Gruppensitzungen wandern ebenfalls', wennGebaut, () => {
  const gs = new modul.Gruppensitzung();
  const empfang = modul.Gruppenempfang.ausVerteilschluessel(gs.verteilschluessel());
  const nachricht = gs.verschluesseln(new TextEncoder().encode('hallo'));

  const plan = umschreibenPlanen(
    [{ schluessel: 'pulse.krypto-gruppenempfang.42.ABC.s1', wert: empfang.einfrieren(ALT) }],
    umfrieren
  );
  const wieder = modul.Gruppenempfang.auftauen(plan[0].wert as string, NEU);
  assert.equal(new TextDecoder().decode(wieder.entschluesseln(nachricht).klartext()), 'hallo');
});

// ---------------------------------------------------------------------------
// Die zweite Zusage: ein misslungener Uebergang schreibt NICHTS
// ---------------------------------------------------------------------------

test('ein einziger unlesbarer Eintrag laesst den ganzen Uebergang scheitern', wennGebaut, () => {
  // Alles-oder-nichts, und zwar SCHON in der Planung: die Verkabelung
  // schreibt erst, wenn die Planung vollstaendig zurueckgekommen ist
  // (`pickelUebergang.ts`). Ein Teil-Uebergang waere das Schlimmste von
  // beidem — die Marke stuende auf „neu", ein Teil des Zustands laege noch
  // unter dem alten Schluessel, und niemand koennte danach sagen, welcher
  // Eintrag zu welchem gehoert.
  const ident = new modul.Identitaet();
  const eintraege = [
    { schluessel: 'pulse.krypto-account', wert: ident.einfrieren(ALT) },
    { schluessel: 'pulse.krypto-sitzung.42:ABC', wert: 'kein gueltiger Pickle' }
  ];
  assert.throws(() => umschreibenPlanen(eintraege, umfrieren));
});

test('ein Eintrag der falschen GESTALT wird geworfen, nicht geraten', () => {
  // Ohne WASM pruefbar: hier scheitert es an der Gestalt, nicht an der
  // Krypto. `null` unter einem Pickle-Schluessel ist ein Zustand, den es
  // nicht geben darf — ihn zu ueberspringen hiesse, ihn nach dem
  // Markenwechsel unlesbar zurueckzulassen.
  assert.throws(
    () => umschreibenPlanen([{ schluessel: 'pulse.krypto-account', wert: null }], () => 'x'),
    /PICKLE_UNERWARTETE_GESTALT/
  );
  assert.throws(
    () =>
      umschreibenPlanen(
        [{ schluessel: 'pulse.krypto-gruppensitzung.42', wert: { sitzungId: 's1' } }],
        () => 'x'
      ),
    /PICKLE_UNERWARTETE_GESTALT/
  );
});

test('die Planung ist leer, wenn es nichts umzufrieren gibt', () => {
  // Der Erstlauf eines frischen Geraets: es gibt keinen eingefrorenen
  // Zustand, also auch keinen Uebergang — nur die Marke wird gesetzt.
  const plan = umschreibenPlanen(
    [
      { schluessel: 'pulse.keypair', wert: { type: 'webcrypto' } },
      { schluessel: 'pulse.krypto-rueckfallschluessel', wert: 'AAAA' }
    ],
    () => {
      throw new Error('haette nicht gerufen werden duerfen');
    }
  );
  assert.deepEqual(plan, []);
});
