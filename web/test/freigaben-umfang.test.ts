import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freigabenUmfang } from '../src/lib/devices/freigabenUmfang.ts';

test('leere Liste -> nicht jeder, Anzahl 0', () => {
  assert.deepEqual(freigabenUmfang([]), { jeder: false, anzahl: 0 });
});

test('everyone-Eintrag -> jeder, unabhängig von weiteren Zeilen', () => {
  assert.deepEqual(
    freigabenUmfang([{ subject_type: 'everyone' }, { subject_type: 'user' }]),
    { jeder: true, anzahl: 2 },
  );
});

test('nur Nutzer/Rollen -> nicht jeder, Anzahl = Zeilenzahl', () => {
  assert.deepEqual(
    freigabenUmfang([{ subject_type: 'user' }, { subject_type: 'role' }, { subject_type: 'user' }]),
    { jeder: false, anzahl: 3 },
  );
});
