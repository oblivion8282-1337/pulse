import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  KeineAntwort,
  mitFrist,
  SPRACHE_FRIST_KETTE_MS,
  SPRACHE_FRIST_SOFORT_MS
} from '../src/lib/platform/brueckenFrist.ts';
import { LetzterWunsch } from '../src/lib/voice/letzterWunsch.ts';

// Die Frist fuer Rufe an die native Huelle (platform/brueckenFrist.ts) und
// die Lautstaerken-Kette, die ohne sie fuer immer stehen bliebe
// (voice/letzterWunsch.ts).

/** Ein Ruf, den die Huelle annimmt und nie beantwortet. */
const nieBeantwortet = () => new Promise<never>(() => undefined);

/** Alle anstehenden Mikroaufgaben abarbeiten lassen. */
const weiter = () => new Promise<void>((r) => setImmediate(r));

test('Antwort vor der Frist: der Wert der Huelle', async () => {
  assert.equal(await mitFrist(Promise.resolve(7), 1_000, 'zustand'), 7);
});

test('Ablehnung vor der Frist: die Ablehnung der Huelle, nicht KeineAntwort', async () => {
  const fehler = new Error('sprache_mikrofon_fehlgeschlagen');
  await assert.rejects(mitFrist(Promise.reject(fehler), 1_000, 'mikrofon'), fehler);
});

test('keine Antwort: nach genau der Frist KeineAntwort, mit Befehl und Frist', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fehler: unknown;
  mitFrist(nieBeantwortet(), SPRACHE_FRIST_KETTE_MS, 'taub').catch((e: unknown) => {
    fehler = e;
  });
  // Ueber eine Funktion gelesen: die Zuweisung im Rueckruf sieht die
  // Typ-Einengung sonst nicht.
  const gefangen = (): unknown => fehler;
  t.mock.timers.tick(SPRACHE_FRIST_KETTE_MS - 1);
  await weiter();
  assert.equal(gefangen(), undefined);
  t.mock.timers.tick(1);
  await weiter();
  const f = gefangen();
  assert.ok(f instanceof KeineAntwort);
  assert.equal(f.befehl, 'taub');
  assert.equal(f.ms, SPRACHE_FRIST_KETTE_MS);
});

test('eine spaete Antwort nach der Frist aendert nichts mehr', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let spaet: (v: string) => void = () => undefined;
  const lauf = mitFrist(new Promise<string>((r) => (spaet = r)), 100, 'kamera');
  t.mock.timers.tick(100);
  spaet('zu spaet');
  await assert.rejects(lauf, KeineAntwort);
});

test('die Fristen: Kette ueber den SDK-Fristen eines Befehls, Sofort darunter', () => {
  // Kamera an: erstes Bild 10 s + Spur-Anmeldung 10 s (LiveKit-Vorgaben,
  // Begruendung an SPRACHE_FRIST_KETTE_MS). Die Frist darf einer echten
  // Fehlermeldung des SDK nie zuvorkommen.
  assert.ok(SPRACHE_FRIST_KETTE_MS > 20_000);
  assert.ok(SPRACHE_FRIST_SOFORT_MS < SPRACHE_FRIST_KETTE_MS);
});

test('LetzterWunsch: einer unterwegs, von den Wartenden nur der letzte', async () => {
  const gesendet: number[] = [];
  const antworten: (() => void)[] = [];
  const kette = new LetzterWunsch<number>((w) => {
    gesendet.push(w);
    return new Promise<void>((r) => antworten.push(r));
  });
  kette.wuenschen(1);
  kette.wuenschen(2);
  kette.wuenschen(3);
  assert.deepEqual(gesendet, [1]);
  antworten[0]();
  await weiter();
  assert.deepEqual(gesendet, [1, 3]);
});

test('LetzterWunsch: ein Fehlschlag haelt die Kette nicht auf', async () => {
  const gesendet: number[] = [];
  const kette = new LetzterWunsch<number>(async (w) => {
    gesendet.push(w);
    if (w === 1) throw new Error('abgelehnt');
  });
  kette.wuenschen(1);
  kette.wuenschen(2);
  await weiter();
  assert.deepEqual(gesendet, [1, 2]);
});

test('die Frist in der Kette: ein nie beantworteter Ruf blockiert sie nicht fuer immer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gesendet: number[] = [];
  const kette = new LetzterWunsch<number>((w) => {
    gesendet.push(w);
    return mitFrist(w === 1 ? nieBeantwortet() : Promise.resolve(), 500, 'lautstaerken');
  });
  kette.wuenschen(1);
  kette.wuenschen(2);
  await weiter();
  assert.deepEqual(gesendet, [1]);
  t.mock.timers.tick(500);
  await weiter();
  assert.deepEqual(gesendet, [1, 2]);
});

test('Gegenprobe: ohne Frist steht die Kette nach einem stummen Ruf fuer immer', async () => {
  const gesendet: number[] = [];
  const kette = new LetzterWunsch<number>((w) => {
    gesendet.push(w);
    return nieBeantwortet();
  });
  kette.wuenschen(1);
  kette.wuenschen(2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(gesendet, [1]);
});
