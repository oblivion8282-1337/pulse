import assert from 'node:assert/strict';
import { test } from 'node:test';
import { merkenSichtbar } from '../src/lib/remote/merkenSichtbar.ts';

test('kein Desktop -> nicht sichtbar, auch mit Eintragung', () => {
  assert.equal(merkenSichtbar({ desktop: false, hatEintragung: true }), false);
});

test('Desktop ohne Eintragung dieses Servers -> nicht sichtbar', () => {
  assert.equal(merkenSichtbar({ desktop: true, hatEintragung: false }), false);
});

test('Desktop mit Eintragung dieses Servers -> sichtbar', () => {
  assert.equal(merkenSichtbar({ desktop: true, hatEintragung: true }), true);
});
