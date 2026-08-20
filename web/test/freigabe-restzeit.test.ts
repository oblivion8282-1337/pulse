import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restzeit } from '../src/lib/devices/restzeit.ts';

const JETZT = Date.UTC(2026, 7, 20, 12, 0, 0);

test('dauerhaft hat keine Restzeit', () => {
  assert.equal(restzeit(null, JETZT), null);
});

test('abgelaufen zaehlt als abgelaufen, nicht als Rest 0', () => {
  assert.equal(restzeit(new Date(JETZT - 1000).toISOString(), JETZT), 'abgelaufen');
});

test('Restzeit rundet auf die groebste sinnvolle Einheit — Struktur statt Text (G-3)', () => {
  // Struktur statt fertigem deutschem Satz: die Übersetzung passiert am
  // Anzeigeort, diese Funktion bleibt sprachneutral (importfrei).
  assert.deepEqual(restzeit(new Date(JETZT + 90 * 60_000).toISOString(), JETZT), {
    einheit: 'stunden',
    anzahl: 2,
  });
  assert.deepEqual(restzeit(new Date(JETZT + 45 * 60_000).toISOString(), JETZT), {
    einheit: 'minuten',
    anzahl: 45,
  });
  assert.deepEqual(restzeit(new Date(JETZT + 50 * 3_600_000).toISOString(), JETZT), {
    einheit: 'tage',
    anzahl: 2,
  });
});
