import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sitzungsSchluessel } from '../src/lib/krypto/sitzungsschluessel.ts';

test('zwei verschiedene Paare ergeben zwei verschiedene Schluessel', () => {
  const a = sitzungsSchluessel('111', 'geraet-a');
  const b = sitzungsSchluessel('111', 'geraet-b');
  const c = sitzungsSchluessel('222', 'geraet-a');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test('dasselbe Paar liefert zweimal denselben Schluessel', () => {
  const a = sitzungsSchluessel('111', 'geraet-a');
  const b = sitzungsSchluessel('111', 'geraet-a');
  assert.equal(a, b);
});
