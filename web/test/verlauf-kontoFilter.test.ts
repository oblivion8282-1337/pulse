import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gehoertZuKonto } from '../src/lib/verlauf/kontoFilter.ts';

// Bughunt 2026-08-29, Befund 1: der lokale Verlauf (`pulse-verlauf`) war pro
// Browserprofil global, ohne Bezug zum angemeldeten Konto. Meldet sich auf
// demselben Geraet ein zweites Konto an, sah dessen Suche den kompletten
// Bestand des ersten. `gehoertZuKonto` ist die einzige Stelle, die das ab
// jetzt verhindert — jeder Lesepfad in `verlauf/db.ts` ruft sie.

test('ein Satz des angemeldeten Kontos zaehlt als eigener', () => {
  assert.equal(gehoertZuKonto({ kontoId: 'konto-a' }, 'konto-a'), true);
});

test('ein Satz eines FREMDEN Kontos zaehlt NICHT als eigener', () => {
  // Das ist genau das Leck aus Befund 1: Konto B durfte Konto As Saetze
  // nicht sehen.
  assert.equal(gehoertZuKonto({ kontoId: 'konto-a' }, 'konto-b'), false);
});

test('ein Satz ohne kontoId (Bestand von vor dem Fix) gehoert zu KEINEM Konto', () => {
  // Fail-closed statt Ratenwette: weder Konto A noch Konto B duerfen eine
  // Zeile ohne Herkunftsangabe sehen.
  assert.equal(gehoertZuKonto({ kontoId: undefined }, 'konto-a'), false);
  assert.equal(gehoertZuKonto({ kontoId: null }, 'konto-a'), false);
});

test('eine leere kontoId ist kein Treffer fuer ein leeres Vergleichskonto', () => {
  // Verteidigung gegen einen degenerierten Aufrufer, der versehentlich ''
  // als "kein Konto" durchreicht (`aktuellesKonto()` liefert dafuer `null`,
  // nie '') — ein Treffer waere hier trotzdem falsch.
  assert.equal(gehoertZuKonto({ kontoId: '' }, ''), false);
});
