import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kennungWaehlen } from '../src/lib/krypto/geraeteKennungWahl.ts';

/**
 * Woher der Klient seine EIGENE Geraetekennung nimmt (Spec §3b, Punkt 1).
 *
 * Bis heute aus `certStore.cert.claims.device_pubkey` — an sieben Stellen,
 * und das Zertifikat faellt weg. Die reine Rechnung dahinter ist klein und
 * steht deshalb importfrei nebenan; die Verkabelung (`geraeteKennung.ts`)
 * liest den Zertifikatsspeicher und ist hier nicht pruefbar.
 *
 * **Der Fall, um den es wirklich geht, ist der dritte Test:** kein
 * Zertifikat mehr, und trotzdem dieselbe Kennung wie vorher. Das ist die
 * Bruecke ueber den Umbau — ohne sie passen nach dem Wegfall des Zertifikats
 * weder die veroeffentlichten Schluesselbuendel noch die Olm-Sitzungen zu
 * dem, wofuer dieses Geraet sich haelt.
 */

test('beim ersten Mal wird die Kennung des Zertifikats uebernommen', () => {
  // Bewusst UEBERNOMMEN und nicht neu erzeugt: der Server fuehrt dieses
  // Geraet unter genau diesem Wert (`DeviceKeyBundle.device_pubkey`), und
  // eine frisch gewuerfelte Kennung waere ein zweites, leeres Geraet neben
  // dem eigenen.
  const wahl = kennungWaehlen(undefined, 'ZERT-ABC');
  assert.equal(wahl.kennung, 'ZERT-ABC');
  assert.equal(wahl.schreiben, true);
});

test('die Kennung ist ueber Neustarts stabil und wird nicht neu geschrieben', () => {
  const wahl = kennungWaehlen('ZERT-ABC', 'ZERT-ABC');
  assert.equal(wahl.kennung, 'ZERT-ABC');
  assert.equal(wahl.schreiben, false);
});

test('ohne Zertifikat traegt die gespeicherte Kennung weiter', () => {
  // Der Zustand nach dem Umbau: das Zertifikat ist geloescht, die Kennung
  // bleibt dieselbe wie zuvor. Genau das macht den Umbau verlustfrei.
  const wahl = kennungWaehlen('ZERT-ABC', undefined);
  assert.equal(wahl.kennung, 'ZERT-ABC');
  assert.equal(wahl.schreiben, false);
});

test('weicht das Zertifikat ab, gewinnt das Zertifikat', () => {
  // Solange es ein Zertifikat gibt, ist SEIN Wert die Kennung, unter der der
  // Server dieses Geraet fuehrt — die gespeicherte ist eine Kopie davon, kein
  // zweiter Wille. Behielte die Kopie recht, adressierte der Klient sich
  // selbst unter einem Namen, den der Server nicht kennt: das eigene Geraet
  // fiele beim Faechern nicht mehr heraus und bekaeme Umschlaege, die es
  // nicht oeffnen kann.
  const wahl = kennungWaehlen('ALT-XYZ', 'ZERT-ABC');
  assert.equal(wahl.kennung, 'ZERT-ABC');
  assert.equal(wahl.schreiben, true);
});

test('ohne beides wird geworfen statt geraten', () => {
  // Kein stiller Rueckfall auf eine leere Kennung: ein Umschlag an "" ginge
  // an niemanden, und der eigene Ausschluss beim Faechern griffe nicht mehr.
  assert.throws(() => kennungWaehlen(undefined, undefined), /KEINE_GERAETEKENNUNG/);
  assert.throws(() => kennungWaehlen('', ''), /KEINE_GERAETEKENNUNG/);
});
