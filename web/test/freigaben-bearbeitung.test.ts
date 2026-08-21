import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mitNeuem, ohne } from '../src/lib/devices/freigabenBearbeitung.ts';

const NUTZER_A = {
  id: 'g1',
  subject_type: 'user' as const,
  subject_id: 'u1',
  expires_at: null,
};
const ROLLE_B = {
  id: 'g2',
  subject_type: 'role' as const,
  subject_id: 'r1',
  expires_at: '2026-08-21T00:00:00Z',
};

test('mitNeuem haengt eine neue Zeile an', () => {
  const naechste = mitNeuem([NUTZER_A], {
    subject_type: 'everyone',
    subject_id: null,
    expires_at: null,
  });
  assert.deepEqual(naechste, [
    { subject_type: 'user', subject_id: 'u1', expires_at: null },
    { subject_type: 'everyone', subject_id: null, expires_at: null },
  ]);
});

test('mitNeuem ersetzt statt zu verdoppeln, wenn Art+Kennung schon vorkommen', () => {
  const naechste = mitNeuem([NUTZER_A, ROLLE_B], {
    subject_type: 'user',
    subject_id: 'u1',
    expires_at: '2026-08-22T00:00:00Z',
  });
  assert.deepEqual(naechste, [
    { subject_type: 'role', subject_id: 'r1', expires_at: '2026-08-21T00:00:00Z' },
    { subject_type: 'user', subject_id: 'u1', expires_at: '2026-08-22T00:00:00Z' },
  ]);
});

test('ohne entfernt genau die Zeile mit der gegebenen Kennung', () => {
  const naechste = ohne([NUTZER_A, ROLLE_B], 'g1');
  assert.deepEqual(naechste, [
    { subject_type: 'role', subject_id: 'r1', expires_at: '2026-08-21T00:00:00Z' },
  ]);
});

test('ohne laesst die Liste unveraendert, wenn die Kennung nicht vorkommt', () => {
  const naechste = ohne([NUTZER_A], 'unbekannt');
  assert.deepEqual(naechste, [{ subject_type: 'user', subject_id: 'u1', expires_at: null }]);
});
