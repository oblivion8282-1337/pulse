import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { filterziel, type Filterlage } from '../src/lib/voice/filterwahl.ts';

const lage = (teil: Partial<Filterlage> = {}): Filterlage => ({
  wunsch: 'rnnoise_gated',
  makeup: 1,
  systemFiltert: false,
  ...teil
});

test('ohne System-Filter entscheidet der Wunsch — wie bisher', () => {
  assert.equal(filterziel(lage()), 'rnnoise_gated');
  assert.equal(filterziel(lage({ wunsch: 'off' })), 'keiner');
  assert.equal(filterziel(lage({ wunsch: 'off', makeup: 1.5 })), 'gain_only');
});

test('filtert das System schon, laeuft RNNoise NICHT — kein zweites Mal', () => {
  // Der Kern dieser Datei: zwei Rauschunterdrueckungen in Reihe schneiden
  // Wortanfaenge ab.
  assert.equal(filterziel(lage({ systemFiltert: true })), 'keiner');
  assert.equal(
    filterziel(lage({ systemFiltert: true, wunsch: 'rnnoise_gated' })),
    'keiner'
  );
});

test('der Makeup-Pegel bleibt auch dann — er filtert nicht, er verstaerkt', () => {
  assert.equal(filterziel(lage({ systemFiltert: true, makeup: 1.5 })), 'gain_only');
  assert.equal(
    filterziel(lage({ systemFiltert: true, wunsch: 'off', makeup: 0.5 })),
    'gain_only'
  );
});

test('auf der Hochqualitaets-Route filtert das System NICHT, also RNNoise schon', () => {
  // mode .default (bluetoothHighQualityRecording) schaltet Apples
  // Sprachverarbeitung ab — dann ist RNNoise der einzige Filter, wofuer er
  // gebaut wurde.
  assert.equal(filterziel(lage({ systemFiltert: false })), 'rnnoise_gated');
});

test('Makeup genau 1 zaehlt als unveraendert', () => {
  assert.equal(filterziel(lage({ wunsch: 'off', makeup: 1 })), 'keiner');
  assert.equal(filterziel(lage({ systemFiltert: true, makeup: 1 })), 'keiner');
});
