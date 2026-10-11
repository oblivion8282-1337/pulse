import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  base64ZuBytes,
  istAnrufSchluessel,
  neuAnrufSchluessel
} from '../src/lib/anrufe/anrufSchluessel.ts';

// Der Anruf-Schlüssel geht seit Etappe 4 an zwei Medienwege — das Web als
// rohe Bytes an livekit-client (HKDF), die iOS-Hülle als base64 an die
// Brücke. Beide müssen dieselben 32 Bytes sehen.

test('ein frischer Schlüssel hat genau 32 Bytes', () => {
  const s = neuAnrufSchluessel();
  assert.equal(base64ZuBytes(s).byteLength, 32);
  assert.equal(istAnrufSchluessel(s), true);
});

test('fail-closed: falsche Länge, kaputtes base64, leer', () => {
  assert.equal(istAnrufSchluessel(btoa('zu kurz')), false);
  assert.equal(istAnrufSchluessel('***kein base64***'), false);
  assert.equal(istAnrufSchluessel(''), false);
});
