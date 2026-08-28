import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wurdeZugestellt } from '../src/lib/krypto/zustellErgebnis.ts';

test('mindestens eine Zustellung gilt als gesendet', () => {
  assert.equal(
    wurdeZugestellt({
      zustellungen_angelegt: 1,
      uebersprungene_empfaenger: [],
      verworfene_nutzlasten: 0
    }),
    true
  );
});

test('null Zustellungen gilt NICHT als gesendet, auch bei 2xx-Antwort (Bughunt 2026-08-28, FIX 2)', () => {
  // Der Server darf jeden angefragten Empfaenger einzeln uebersprungen haben
  // (unbekanntes Buendel, Kontingent voll) und antwortet trotzdem mit 2xx —
  // ohne diese Pruefung haette der Absender geglaubt, die Nachricht sei
  // zugestellt, obwohl sie nirgends existiert.
  assert.equal(
    wurdeZugestellt({
      zustellungen_angelegt: 0,
      uebersprungene_empfaenger: ['geraet-a'],
      verworfene_nutzlasten: 1
    }),
    false
  );
});

test('null Zustellungen ohne uebersprungene Empfaenger gilt ebenfalls nicht als gesendet', () => {
  assert.equal(
    wurdeZugestellt({
      zustellungen_angelegt: 0,
      uebersprungene_empfaenger: [],
      verworfene_nutzlasten: 0
    }),
    false
  );
});
