import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reiterSichtbar } from '../src/lib/devices/reiterSichtbar.ts';

test('Windows-Rechner sieht den Reiter immer', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: true, hatEintragung: false, besitztGeraete: false }),
    true,
  );
});

test('Linux mit eigenen Geraeten sieht ihn — das ist der neue Fall', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: false, hatEintragung: false, besitztGeraete: true }),
    true,
  );
});

test('Linux mit alter Eintragung sieht ihn — sonst kaeme er nie wieder los', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: false, hatEintragung: true, besitztGeraete: false }),
    true,
  );
});

test('Linux ohne alles sieht ihn nicht', () => {
  assert.equal(
    reiterSichtbar({ kannStandplatzSein: false, hatEintragung: false, besitztGeraete: false }),
    false,
  );
});
