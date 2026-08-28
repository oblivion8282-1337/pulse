import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickelschluesselAbleiten } from '../src/lib/krypto/pickelschluessel.ts';

test('derselbe Eingang ergibt denselben Schluessel', async () => {
  // Der ganze Ansatz haengt daran. Waere die Ableitung nicht stabil, liesse
  // sich der eingefrorene Zustand nach einem Neustart nicht mehr oeffnen —
  // und zwar still, weil ein falscher Schluessel wie ein beschaedigter
  // Zustand aussieht.
  const eingang = new Uint8Array(64).fill(3).buffer;
  const a = await pickelschluesselAbleiten(eingang);
  const b = await pickelschluesselAbleiten(eingang);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
});

test('verschiedene Eingaenge ergeben verschiedene Schluessel', async () => {
  const a = await pickelschluesselAbleiten(new Uint8Array(64).fill(3).buffer);
  const b = await pickelschluesselAbleiten(new Uint8Array(64).fill(4).buffer);
  assert.notDeepEqual(a, b);
});
