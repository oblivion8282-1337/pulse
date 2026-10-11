import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { TonHalter } from '../src/lib/platform/nativeTonHalter.ts';

// Sprachkanal und Anruf halten unabhängig einen nativen Raum (Etappe 4).
// WebKits `ambient` und die Ruhe von `iosTon` müssen bleiben, bis der
// LETZTE geht — das Auflegen darf dem Kanal nichts wegnehmen.

function mitschrift(): { halter: TonHalter; wechsel: boolean[] } {
  const wechsel: boolean[] = [];
  return { halter: new TonHalter((an) => wechsel.push(an)), wechsel };
}

test('Anruf neben dem Kanal: erst das Ende des letzten gibt frei', () => {
  const { halter, wechsel } = mitschrift();
  halter.setzen('sprachkanal', true);
  halter.setzen('anruf', true);
  halter.setzen('anruf', false);
  assert.deepEqual(wechsel, [true]);
  assert.equal(halter.gehalten, true);
  halter.setzen('sprachkanal', false);
  assert.deepEqual(wechsel, [true, false]);
});

test('doppeltes An- und Abmelden ist ohne Wirkung', () => {
  const { halter, wechsel } = mitschrift();
  halter.setzen('anruf', true);
  halter.setzen('anruf', true);
  halter.setzen('sprachkanal', false);
  halter.setzen('anruf', false);
  halter.setzen('anruf', false);
  assert.deepEqual(wechsel, [true, false]);
});
