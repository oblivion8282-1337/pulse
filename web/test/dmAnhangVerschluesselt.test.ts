/**
 * Gegenprobe zu `$lib/attachments/dmAnhangVerschluesselt.ts`.
 *
 * Anlass: `+page.svelte` speiste `verschluesselteAnhaenge` bisher aus
 * `E2E_DMS_ENABLED` (dem globalen Schalter) statt aus dem Schloss-Stand
 * dieses Gespräächs — der erste Test hier belegt die alte, falsche Formel
 * (globaler Schalter allein) rot gegen die gewünschte Antwort; die
 * restlichen Tests decken die neue Funktion ab.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dmAnhangVerschluesselt } from '../src/lib/attachments/dmAnhangVerschluesselt.ts';
import { anhangKnopfSichtbar } from '../src/lib/attachments/anhangKnopfSichtbar.ts';

describe('dmAnhangVerschluesselt — Beleg der alten Formel', () => {
  test('globaler Schalter allein (die alte Formel) liegt bei unverschluesselter Gegenstelle falsch', () => {
    const featureSchalterEin = true;
    const alteFormel = featureSchalterEin; // == heutiges (fehlerhaftes) verschluesselteAnhaenge
    const knopfMitAlterFormel = anhangKnopfSichtbar('dm', alteFormel, undefined);
    // Die alte Formel zeigt den Knopf faelschlich — genau der gemeldete Fehler.
    assert.equal(knopfMitAlterFormel, true);
    // Die neue Funktion liegt fuer denselben Fall richtig:
    const gespraechsStandUnverschluesselt = false;
    assert.equal(
      dmAnhangVerschluesselt(featureSchalterEin, gespraechsStandUnverschluesselt),
      false
    );
  });
});

describe('dmAnhangVerschluesselt — die vier Faelle', () => {
  test('Schalter aus → immer false, unabhaengig vom Stand', () => {
    assert.equal(dmAnhangVerschluesselt(false, undefined), false);
    assert.equal(dmAnhangVerschluesselt(false, true), false);
    assert.equal(dmAnhangVerschluesselt(false, false), false);
  });

  test('Schalter an, Stand noch unbekannt → false', () => {
    assert.equal(dmAnhangVerschluesselt(true, undefined), false);
  });

  test('Schalter an, Gegenstelle ohne dauerhaftes Geraet → false', () => {
    assert.equal(dmAnhangVerschluesselt(true, false), false);
  });

  test('Schalter an, Gegenstelle verschluesselt → true', () => {
    assert.equal(dmAnhangVerschluesselt(true, true), true);
  });
});
