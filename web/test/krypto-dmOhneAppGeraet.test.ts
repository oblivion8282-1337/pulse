/**
 * Gegenprobe zu `$lib/krypto/dmOhneAppGeraet.ts`.
 *
 * Anlass: Spec §3a, Punkt 1 — ein Konto ohne App-Geraet darf beim Oeffnen
 * der Direktnachrichten keine leere Liste sehen, sondern einen Hinweis. Die
 * drei Faelle hier sind genau die, die ohne die Aenderung rot sind:
 *  1. Schalter aus -> der Bildschirm erscheint nie.
 *  2. Schalter an, aber Stand unbekannt -> der Bildschirm erscheint nie
 *     (kein kurzes Aufblitzen).
 *  3. Schalter an und Geraet vorhanden -> der Bildschirm erscheint nie.
 * Nur Schalter an UND `eigenerStand === false` zeigt ihn.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dmOhneAppGeraet } from '../src/lib/krypto/dmOhneAppGeraet.ts';

describe('dmOhneAppGeraet — Schalter AUS', () => {
  test('erscheint nie, egal welcher Stand', () => {
    assert.equal(dmOhneAppGeraet(false, false), false);
    assert.equal(dmOhneAppGeraet(false, undefined), false);
    assert.equal(dmOhneAppGeraet(false, true), false);
  });
});

describe('dmOhneAppGeraet — Schalter AN', () => {
  test('Stand unbekannt -> nicht anzeigen', () => {
    assert.equal(dmOhneAppGeraet(true, undefined), false);
  });

  test('eigenes App-Geraet vorhanden -> nicht anzeigen', () => {
    assert.equal(dmOhneAppGeraet(true, true), false);
  });

  test('kein eigenes App-Geraet -> anzeigen', () => {
    assert.equal(dmOhneAppGeraet(true, false), true);
  });
});
