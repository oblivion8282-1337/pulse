/**
 * Die Alters-Entscheidung für Gilden-Klang-Links (`sounds/frische.ts`).
 *
 * Geprüft wird der 8-Minuten-Rhythmus, an dem der Stille-Fehler vom
 * 2026-10-06 hing: „veraltet" (nach 8 Min) darf den Link NICHT mehr
 * wegwerfen — er wird nur noch parallel erneuert. Schweigen erst, wenn
 * die 30-Minuten-Signatur wirklich am Ende ist (minus Puffer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { klangLinkUrteil, PRESIGN_TTL_S, REFRESH_AFTER_S } from '../src/lib/sounds/frische.ts';

test('frischer Link: spielen, keine Erneuerung nötig', () => {
  assert.deepEqual(klangLinkUrteil(0), { spielen: true, erneuern: false });
});

test('die 8-Minuten-Grenze selbst erneuert noch nicht (strikt größer)', () => {
  assert.deepEqual(klangLinkUrteil(REFRESH_AFTER_S), { spielen: true, erneuern: false });
  assert.deepEqual(klangLinkUrteil(REFRESH_AFTER_S + 0.001), {
    spielen: true,
    erneuern: true
  });
});

test('veralteter Link (typischer Fall nach einer Pause) wird GESPIELT und parallel erneuert', () => {
  assert.deepEqual(klangLinkUrteil(600), { spielen: true, erneuern: true });
});

test('erst am Signaturende (TTL minus Puffer) wird geschwiegen', () => {
  assert.equal(PRESIGN_TTL_S, 1800);
  const grenze = PRESIGN_TTL_S - 60;
  assert.deepEqual(klangLinkUrteil(grenze), { spielen: true, erneuern: true });
  assert.deepEqual(klangLinkUrteil(grenze + 0.001), { spielen: false, erneuern: true });
});
