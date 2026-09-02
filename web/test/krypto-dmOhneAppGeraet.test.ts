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

import { dmOhneAppGeraet, wandEntscheidung } from '../src/lib/krypto/dmOhneAppGeraet.ts';

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

// B11 (2026-09-02): WAS an der Wand-Stelle steht, wenn sie steht. In der App
// (Electron/Android-Huelle) hat der Nutzer sein Geraet in der Hand — dort
// wird DIESES eingerichtet (automatisch angestossen, Knopf als Handlauf).
// Im Browser bleibt es bei der alten Wand mit Apps/Kopplung (Regel d4cd6aee).
describe('wandEntscheidung — App-Kontext', () => {
  test('kein eigenes Geraet -> Einrichtung anbieten', () => {
    assert.equal(wandEntscheidung(true, true, false), 'einrichtung');
  });

  test('Geraet vorhanden oder Stand unbekannt -> keine Wand', () => {
    assert.equal(wandEntscheidung(true, true, true), 'keine');
    assert.equal(wandEntscheidung(true, true, undefined), 'keine');
  });
});

describe('wandEntscheidung — Browser', () => {
  test('kein eigenes Geraet -> Wand wie bisher (Apps/Kopplung), kein Auto-Setup', () => {
    assert.equal(wandEntscheidung(true, false, false), 'apps');
  });

  test('Schalter aus -> nie etwas, egal welcher Kontext', () => {
    assert.equal(wandEntscheidung(false, true, false), 'keine');
    assert.equal(wandEntscheidung(false, false, false), 'keine');
  });
});
