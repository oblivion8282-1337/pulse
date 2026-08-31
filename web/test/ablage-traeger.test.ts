import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traegerWaehlen } from '../src/lib/remote/ablageTraeger.ts';

test('ohne laufenden Stream traegt niemand', () => {
  // Kein Stream heisst kein Sidecar-Prozess. Einen zu adressieren startete
  // einen, nur damit er die Zwischenablage eines Rechners beansprucht, der
  // gerade gar nichts ueberträgt.
  assert.equal(traegerWaehlen([], null), null);
  assert.equal(traegerWaehlen([], 0), null, 'auch ein bisheriger Traeger ist dann weg');
});

test('der bisherige Traeger bleibt es, solange sein Stream laeuft', () => {
  // Ein Wechsel ist nicht gratis: der neue Prozess beginnt seine
  // Generationszaehlung bei null, und der Vorbestand des Nutzers wandert durch
  // eine Freigabe. Gewechselt wird nur, wenn es sein muss.
  assert.equal(traegerWaehlen([0, 1, 2], 2), 2);
  assert.equal(traegerWaehlen([0, 1], 1), 1);
});

test('endet der Traeger-Stream, wird neu gewaehlt', () => {
  // Genau der Fall, den `dispatch.rs` erzwingt: der Windows-Sidecar beendet
  // sich nach `stop`. Endet ausgerechnet der Traeger-Stream, waehrend ein
  // anderer laeuft, gibt es sonst niemanden, der die Ablage haelt.
  assert.equal(traegerWaehlen([1, 2], 0), 1);
});

test('ohne bisherigen Traeger gewinnt der kleinste Platz', () => {
  // Welcher es ist, ist gleichgueltig — festgelegt wird es trotzdem, damit
  // zwei Aufrufe im selben Zustand dieselbe Antwort geben.
  assert.equal(traegerWaehlen([2, 0, 1], null), 0);
  assert.equal(traegerWaehlen([3], null), 3);
});

test('unbrauchbare Plaetze werden uebergangen', () => {
  // Fail-closed wie im ganzen Fernsteuerungs-Weg: ein verbogener Platz waere
  // ein Auftrag an einen Prozess, den es nicht gibt.
  assert.equal(traegerWaehlen([-1, 1.5, 2] as number[], null), 2);
  assert.equal(traegerWaehlen([-1] as number[], null), null);
});
