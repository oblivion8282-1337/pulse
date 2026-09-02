import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nutzlastIdAusName, sortiereNamen } from '../src/lib/ablage/ordnerDateien.ts';

test('nutzlastIdAusName liest die Nutzlast-ID aus dem Dateinamen', () => {
  assert.equal(nutzlastIdAusName('17.puls'), '17');
});

test('nutzlastIdAusName lehnt Fremdnamen ab', () => {
  assert.equal(nutzlastIdAusName('17.txt'), null);
  assert.equal(nutzlastIdAusName('abc.puls'), null);
  assert.equal(nutzlastIdAusName('.puls'), null);
  assert.equal(nutzlastIdAusName('17'), null);
  assert.equal(nutzlastIdAusName('17.puls.puls'), null);
});

test('sortiereNamen ordnet numerisch, nicht als String', () => {
  // Als String stuende "10.puls" vor "9.puls" — numerisch ist es umgekehrt.
  assert.deepEqual(sortiereNamen(['10.puls', '9.puls', '2.puls']), [
    '2.puls',
    '9.puls',
    '10.puls'
  ]);
});

test('sortiereNamen wirft Fremdes raus', () => {
  assert.deepEqual(sortiereNamen(['3.puls', 'unsinn.txt', '1.puls']), ['1.puls', '3.puls']);
});

test('sortiereNamen sortiert ueber den BigInt-Bereich hinaus korrekt', () => {
  const gross = '99999999999999999999.puls';
  const groesser = '100000000000000000000.puls';
  assert.deepEqual(sortiereNamen([groesser, gross]), [gross, groesser]);
});

test('sortiereNamen liefert bei leerer Liste leere Liste', () => {
  assert.deepEqual(sortiereNamen([]), []);
});
