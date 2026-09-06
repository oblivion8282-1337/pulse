import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vorhalt, VORHALT_MAX } from '../src/lib/remote/ablageVorhalt.ts';

test('was vor dem Ziel eintrifft, geht nicht verloren', () => {
  // Der Befund aus Plan 1b-1: ein `neu` vor dem ersten `setSenke` ging an
  // Sitzung 0, die es nicht gibt, und war weg. Eine Auffrischung liess sich
  // nicht erbitten — `neu_bitte` ist lokal —, also blieb die Zwischenablage in
  // einer Richtung tot, ohne Log und ohne sichtbare Ursache.
  const v = new Vorhalt();
  v.zurueckhalten({ t: 'neu', gen: 1 });
  v.zurueckhalten({ t: 'neu', gen: 2 });
  assert.deepEqual(v.abholen(), [
    { t: 'neu', gen: 1 },
    { t: 'neu', gen: 2 },
  ]);
});

test('abgeholt wird genau einmal', () => {
  const v = new Vorhalt();
  v.zurueckhalten('a');
  assert.deepEqual(v.abholen(), ['a']);
  assert.deepEqual(v.abholen(), [], 'sonst kaeme jeder Rahmen zweimal an');
});

test('ueber der Grenze faellt der AELTESTE', () => {
  // Die richtige Seite: was hier wartet, sind Ankuendigungen, und eine neuere
  // macht die aeltere gegenstandslos. Ohne Grenze waere der Vorhalt ein
  // Speicherloch, das die Gegenstelle fuellt.
  const v = new Vorhalt(3);
  for (const n of [1, 2, 3, 4, 5]) v.zurueckhalten(n);
  assert.deepEqual(v.abholen(), [3, 4, 5]);
});

test('die Vorgabe-Grenze bleibt klein', () => {
  assert.ok(VORHALT_MAX <= 8, `${VORHALT_MAX} ist mehr, als je gebraucht wird`);
  const v = new Vorhalt();
  for (let i = 0; i < 100; i++) v.zurueckhalten(i);
  assert.equal(v.anzahl, VORHALT_MAX);
});

test('leeren stellt nichts zu', () => {
  // Sitzungsende: was noch wartet, gehoert einer Sitzung, die es nicht mehr
  // gibt.
  const v = new Vorhalt();
  v.zurueckhalten('a');
  v.leeren();
  assert.deepEqual(v.abholen(), []);
});
