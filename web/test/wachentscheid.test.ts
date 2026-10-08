import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  GESCHLOSSEN,
  MINDESTABSTAND_MS,
  OFFEN,
  SCHLIESST,
  VERBINDET,
  wachEntscheid,
  type Wachlage
} from '../src/lib/ws/wachentscheid.ts';

const lage = (teil: Partial<Wachlage> = {}): Wachlage => ({
  gewuenscht: true,
  bereit: GESCHLOSSEN,
  pruefungLaeuft: false,
  seitLetzterPruefungMs: 60_000,
  ...teil
});

test('abgemeldet: nichts tun, egal wie der Socket steht', () => {
  assert.equal(wachEntscheid(lage({ gewuenscht: false, bereit: OFFEN })), 'nichts');
  assert.equal(wachEntscheid(lage({ gewuenscht: false, bereit: null })), 'nichts');
});

test('kein Socket oder geschlossen: sofort verbinden', () => {
  assert.equal(wachEntscheid(lage({ bereit: null })), 'sofort-verbinden');
  assert.equal(wachEntscheid(lage({ bereit: GESCHLOSSEN })), 'sofort-verbinden');
});

test('im Abbau zaehlt wie geschlossen — der close-Pfad wartet sonst auf den Backoff', () => {
  assert.equal(wachEntscheid(lage({ bereit: SCHLIESST })), 'sofort-verbinden');
});

test('Aufbau laeuft schon: kein zweiter daneben', () => {
  assert.equal(wachEntscheid(lage({ bereit: VERBINDET })), 'nichts');
});

test('offener Socket beweist nichts: Ping mit kurzer Frist', () => {
  assert.equal(wachEntscheid(lage({ bereit: OFFEN })), 'ping-pruefen');
});

test('laufende Pruefung wird nicht verdoppelt', () => {
  assert.equal(wachEntscheid(lage({ bereit: OFFEN, pruefungLaeuft: true })), 'nichts');
});

test('die drei Ausloeser beim Entsperren feuern gemeinsam — nur der erste zaehlt', () => {
  assert.equal(wachEntscheid(lage({ seitLetzterPruefungMs: 0 })), 'nichts');
  assert.equal(
    wachEntscheid(lage({ seitLetzterPruefungMs: MINDESTABSTAND_MS - 1 })),
    'nichts'
  );
  assert.equal(
    wachEntscheid(lage({ seitLetzterPruefungMs: MINDESTABSTAND_MS })),
    'sofort-verbinden'
  );
});
