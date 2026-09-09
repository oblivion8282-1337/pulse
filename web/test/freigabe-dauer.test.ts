import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ablaufAb,
  FREIGABE_DAUERN,
  FREIGABE_DAUER_VORGABE,
  istFreigabeDauer,
} from '../src/lib/devices/freigabeDauer.ts';

const JETZT = Date.UTC(2026, 8, 9, 12, 0, 0);

test('dauerhaft hat keinen Ablauf', () => {
  assert.equal(ablaufAb('dauerhaft', JETZT), null);
});

test('die Stufen rechnen ab jetzt, nicht ab einer stehenden Uhr', () => {
  assert.equal(ablaufAb('1h', JETZT), new Date(JETZT + 3_600_000).toISOString());
  assert.equal(ablaufAb('8h', JETZT), new Date(JETZT + 8 * 3_600_000).toISOString());
  assert.equal(ablaufAb('1d', JETZT), new Date(JETZT + 24 * 3_600_000).toISOString());
  assert.equal(ablaufAb('1w', JETZT), new Date(JETZT + 7 * 24 * 3_600_000).toISOString());
});

test('die Vorgabe ist eine der Stufen, und Fremdes wird abgewiesen', () => {
  assert.ok(FREIGABE_DAUERN.includes(FREIGABE_DAUER_VORGABE));
  for (const d of FREIGABE_DAUERN) assert.ok(istFreigabeDauer(d));
  assert.equal(istFreigabeDauer('2h'), false);
  assert.equal(istFreigabeDauer(8), false);
  assert.equal(istFreigabeDauer(null), false);
});
