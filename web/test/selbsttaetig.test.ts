import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selbsttaetig } from '../src/lib/remote/selbsttaetigRegel.ts';

test('ohne Server-Freigabe niemals selbsttaetig', () => {
  assert.equal(selbsttaetig({ geladen: true, aktiv: true, freigabe: false }), false);
});

test('mit ausgeschaltetem Hauptschalter niemals selbsttaetig', () => {
  assert.equal(selbsttaetig({ geladen: true, aktiv: false, freigabe: true }), false);
});

test('vor dem Laden des Speichers niemals selbsttaetig', () => {
  assert.equal(selbsttaetig({ geladen: false, aktiv: true, freigabe: true }), false);
});

test('alles drei erfuellt', () => {
  assert.equal(selbsttaetig({ geladen: true, aktiv: true, freigabe: true }), true);
});
