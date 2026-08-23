import { test } from 'node:test';
import assert from 'node:assert/strict';
import { darfStandplatzSeinAus } from '../src/lib/remote/darfStandplatzSeinPruefung.ts';

test('Electron + Faehigkeit -> ja (der Regelfall unter Windows)', () => {
  assert.equal(darfStandplatzSeinAus(true, true), true);
});

test('Browser (kein Electron), egal was die Faehigkeit sagt -> nein', () => {
  assert.equal(darfStandplatzSeinAus(false, true), false);
});

test('Electron, aber Faehigkeit fehlt (z. B. Mac ohne Accessibility-Freigabe) -> nein', () => {
  assert.equal(darfStandplatzSeinAus(true, false), false);
});

test('weder Electron noch Faehigkeit -> nein', () => {
  assert.equal(darfStandplatzSeinAus(false, false), false);
});
