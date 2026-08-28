import { test } from 'node:test';
import assert from 'node:assert/strict';

import { baueNutzlast } from '../src/lib/krypto/nutzlast.ts';

// Erwartete Byte-Folgen wurden aus dem Backend erzeugt, NICHT hier
// hergeleitet — direkter Aufruf von
// `services/chat-gateway/src/dcc_chat_gateway/schluessel_nachweis.py::baue_nutzlast`
// mit denselben Eingaben:
//
//   from dcc_chat_gateway.schluessel_nachweis import baue_nutzlast
//   list(baue_nutzlast('buendel', 'curve25519-test-wert', ''))
//   list(baue_nutzlast('buendel', 'curve25519-test-wert', 'rueckfall-wert'))
//   list(baue_nutzlast('einmalschluessel', 'k1', 'k2', 'k3'))
//
// Weicht eine Seite spaeter ab, faellt genau dieser Test — nicht erst ein
// 403 beim Veroeffentlichen, dessen Meldung absichtlich nicht sagt, woran
// es lag.

test('buendel ohne Rueckfallschluessel stimmt byte fuer byte mit dem Backend ueberein', () => {
  const erwartet = new Uint8Array([
    112, 117, 108, 115, 101, 45, 115, 99, 104, 108, 117, 101, 115, 115, 101, 108, 45, 110, 97, 99,
    104, 119, 101, 105, 115, 45, 118, 49, 0, 98, 117, 101, 110, 100, 101, 108, 0, 99, 117, 114,
    118, 101, 50, 53, 53, 49, 57, 45, 116, 101, 115, 116, 45, 119, 101, 114, 116, 0
  ]);
  const ergebnis = baueNutzlast('buendel', 'curve25519-test-wert', '');
  assert.deepEqual(ergebnis, erwartet);
});

test('buendel mit Rueckfallschluessel stimmt byte fuer byte mit dem Backend ueberein', () => {
  const erwartet = new Uint8Array([
    112, 117, 108, 115, 101, 45, 115, 99, 104, 108, 117, 101, 115, 115, 101, 108, 45, 110, 97, 99,
    104, 119, 101, 105, 115, 45, 118, 49, 0, 98, 117, 101, 110, 100, 101, 108, 0, 99, 117, 114,
    118, 101, 50, 53, 53, 49, 57, 45, 116, 101, 115, 116, 45, 119, 101, 114, 116, 0, 114, 117, 101,
    99, 107, 102, 97, 108, 108, 45, 119, 101, 114, 116
  ]);
  const ergebnis = baueNutzlast('buendel', 'curve25519-test-wert', 'rueckfall-wert');
  assert.deepEqual(ergebnis, erwartet);
});

test('einmalschluessel-Batch stimmt byte fuer byte mit dem Backend ueberein', () => {
  const erwartet = new Uint8Array([
    112, 117, 108, 115, 101, 45, 115, 99, 104, 108, 117, 101, 115, 115, 101, 108, 45, 110, 97, 99,
    104, 119, 101, 105, 115, 45, 118, 49, 0, 101, 105, 110, 109, 97, 108, 115, 99, 104, 108, 117,
    101, 115, 115, 101, 108, 0, 107, 49, 0, 107, 50, 0, 107, 51
  ]);
  const ergebnis = baueNutzlast('einmalschluessel', 'k1', 'k2', 'k3');
  assert.deepEqual(ergebnis, erwartet);
});
