import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Das WASM-Paket ist ein BAUERGEBNIS und liegt nicht im Repo (`pkg/` ist
// gitignoriert). Auf einer Maschine, auf der `bauen-wasm.sh` nie lief — jeder
// frische Klon, der Mac, die Windows-Rechner —, gibt es es schlicht nicht.
//
// Die erste Fassung importierte es oben ohne Absicherung. Das riss die ganze
// Datei mit, und weil `pnpm test:unit` im Test-Gate haengt, waere das Gate dort
// ROT gewesen: `ship.sh` haette auf jeder anderen Maschine blockiert, mit einem
// Fehler, der nach einem kaputten Krypto-Kern aussieht statt nach einem
// fehlenden Bauschritt.
//
// Deshalb: fehlt das Paket, werden die Tests ausdruecklich UEBERSPRUNGEN, mit
// dem Befehl als Begruendung. Nodes Laeufer zaehlt Uebersprungenes getrennt aus
// (`skipped: n`) und zeigt den Grund — es verschwindet also nicht in der
// Gruen-Meldung. Wer sie wirklich laufen lassen will, baut das Paket; das Gate
// tut das von sich aus, sobald `wasm-pack` vorhanden ist (scripts/gate-rust.sh).
const pfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto.js', import.meta.url);
const wasmPfad = new URL('../../krypto/pulse-krypto/pkg/pulse_krypto_bg.wasm', import.meta.url);

// Bewusst ungetypt: das Paket entsteht erst beim Bauen durch wasm-bindgen, es
// gibt zur Pruefzeit also keine Typen dafuer — und es liegt nicht im Repo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modul: any = null;
let fehlgrund = '';
try {
  modul = await import(pfad.href);
  // `--target web` laedt sein .wasm sonst per `fetch(import.meta.url)` — Nodes
  // fetch kennt aber keine file://-URLs. Die Bytes deshalb selbst einlesen.
  await modul.default(await readFile(wasmPfad));
} catch (fehler) {
  modul = null;
  fehlgrund =
    'WASM-Paket nicht gebaut — `bash krypto/pulse-krypto/bauen-wasm.sh` ' +
    `ausfuehren. (${(fehler as Error).message})`;
}

/** Leer, wenn gebaut; sonst ein Ueberspringen mit Begruendung. */
const wennGebaut = fehlgrund ? { skip: fehlgrund } : {};

test('WASM: Alice und Bob bauen eine Sitzung auf und schreiben in beide Richtungen', wennGebaut, () => {
  const alice = new modul.Identitaet();
  const bob = new modul.Identitaet();

  const einmal = bob.einmalschluesselErzeugen(1);
  assert.equal(einmal.length, 1);
  bob.alsVeroeffentlichtMarkieren();
  assert.equal(bob.offeneEinmalschluessel().length, 0);

  // Alice schreibt zuerst — das ist der Sitzungsaufbau (Olm-PreKey).
  const alicesSitzung = alice.sitzungAusgehend(bob.curve25519(), einmal[0]);
  const ersterUmschlag = alicesSitzung.verschluesseln(new TextEncoder().encode('hallo Bob'));
  assert.equal(ersterUmschlag.art(), 0);

  const ergebnis = bob.sitzungEingehend(alice.curve25519(), ersterUmschlag);
  assert.equal(new TextDecoder().decode(ergebnis.klartext()), 'hallo Bob');
  const bobsSitzung = ergebnis.sitzung();

  // Rueckweg — ab jetzt sind es laufende Nachrichten.
  const antwortUmschlag = bobsSitzung.verschluesseln(new TextEncoder().encode('hallo Alice'));
  assert.equal(antwortUmschlag.art(), 1);
  const antwortKlartext = alicesSitzung.entschluesseln(antwortUmschlag);
  assert.equal(new TextDecoder().decode(antwortKlartext), 'hallo Alice');

  // Der Umschlag ueberquert die Grenze als eigene Klasse, nicht als rohes
  // Objekt — art()/daten() lesen zurueck, was hineingegeben wurde.
  const nachgebaut = new modul.Umschlag(antwortUmschlag.art(), antwortUmschlag.daten());
  assert.equal(nachgebaut.art(), antwortUmschlag.art());
  assert.equal(nachgebaut.daten(), antwortUmschlag.daten());
});

test('WASM: eine Gruppensitzung verschluesselt, der Empfang liest mit', wennGebaut, () => {
  const senderin = new modul.Gruppensitzung();
  const verteilschluessel = senderin.verteilschluessel();

  const erste = senderin.verschluesseln(new TextEncoder().encode('erste Nachricht'));
  const zweite = senderin.verschluesseln(new TextEncoder().encode('zweite Nachricht'));
  assert.equal(senderin.nachrichtenzaehler(), 2);

  const empfang = modul.Gruppenempfang.ausVerteilschluessel(verteilschluessel);
  const gelesenEins = empfang.entschluesseln(erste);
  assert.equal(new TextDecoder().decode(gelesenEins.klartext()), 'erste Nachricht');
  assert.equal(gelesenEins.zaehler(), 0);

  const gelesenZwei = empfang.entschluesseln(zweite);
  assert.equal(new TextDecoder().decode(gelesenZwei.klartext()), 'zweite Nachricht');
  assert.equal(gelesenZwei.zaehler(), 1);
});

test('WASM: Einfrieren und Auftauen einer Identitaet ueberlebt einen Neustart', wennGebaut, () => {
  const schluessel = new Uint8Array(32).fill(7);
  const ich = new modul.Identitaet();
  ich.einmalschluesselErzeugen(2);

  const gefroren = ich.einfrieren(schluessel);
  const wieder = modul.Identitaet.auftauen(gefroren, schluessel);
  assert.equal(wieder.curve25519(), ich.curve25519());

  const falscherSchluessel = new Uint8Array(32).fill(9);
  assert.throws(() => modul.Identitaet.auftauen(gefroren, falscherSchluessel));

  // Ein Schluessel falscher Laenge darf nicht erst im Rust-Code scheitern,
  // sondern schon an der Grenze — [u8; 32] laesst sich nicht anders pruefen.
  assert.throws(() => ich.einfrieren(new Uint8Array(16)));
});
