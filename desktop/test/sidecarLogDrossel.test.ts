import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDrossel } from '../electron/sidecar-log-drossel.ts';

test('der Schwall geht vollstaendig durch — die ersten Zeilen sind die wertvollen', () => {
  const d = createDrossel(20, 200);
  for (let i = 0; i < 200; i += 1) {
    assert.equal(d.darf(1_000), true, `Zeile ${i} des Schwalls muss durch`);
  }
  assert.equal(d.darf(1_000), false, 'danach ist der Vorrat leer');
});

test('nach dem Schwall wird auf die Dauerrate gedrosselt', () => {
  const d = createDrossel(20, 5);
  for (let i = 0; i < 5; i += 1) d.darf(0);
  assert.equal(d.darf(0), false);
  // 20 je Sekunde = eine alle 50 ms.
  assert.equal(d.darf(49), false, 'knapp zu frueh');
  assert.equal(d.darf(50), true, 'nach 50 ms ist eine wieder frei');
  assert.equal(d.darf(50), false, 'aber nur eine');
});

test('ausgelassene Zeilen werden gezaehlt und gemeldet, nicht verschwiegen', () => {
  const d = createDrossel(20, 2);
  d.darf(0);
  d.darf(0);
  assert.equal(d.nachtrag(0), null, 'ohne Ausfaelle gibt es nichts zu melden');
  for (let i = 0; i < 7; i += 1) assert.equal(d.darf(0), false);
  assert.equal(d.nachtrag(0), null, 'solange kein Platz ist, wird nicht gemeldet');
  const text = d.nachtrag(100);
  assert.ok(text && text.includes('7 Zeilen'), `Zahl muss drinstehen, war: ${text}`);
  assert.equal(d.nachtrag(200), null, 'die Meldung kommt nur einmal je Stau');
});

test('die Meldung verdraengt keine echte Zeile bei anhaltender Flut', () => {
  const d = createDrossel(20, 1);
  d.darf(0);
  for (let i = 0; i < 100; i += 1) d.darf(0);
  // Kein Platz -> keine Meldung. Sonst entstuende aus der Flut eine zweite
  // Flut aus Meldungen.
  assert.equal(d.nachtrag(0), null);
});

test('eine ruhige Leitung wird nie gedrosselt', () => {
  const d = createDrossel(20, 200);
  let t = 0;
  for (let i = 0; i < 500; i += 1) {
    t += 1_000; // eine Zeile je Sekunde
    assert.equal(d.darf(t), true);
  }
  assert.equal(d.nachtrag(t), null, 'und es gibt nichts nachzutragen');
});
