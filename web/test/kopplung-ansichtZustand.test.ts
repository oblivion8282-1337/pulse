/**
 * Sichtbarkeits-Regeln der beiden Kopplungs-Ansichten (Bughunt 2026-08-29,
 * Befund 1 + 3). Node-Haelfte, weil die Svelte-Komponenten selbst nicht
 * pruefbar sind (s. CLAUDE.md „Die Falle").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kannErneutSchieben, kannVerwerfen } from '../src/lib/kopplung/ansichtZustand.ts';

test('Befund 1: nach einem Fehlschlag mit weiterhin bekannter Kennung darf erneut geschoben werden', () => {
  assert.equal(kannErneutSchieben('kid-1', 'Netzwerkfehler', false), true);
});

test('Befund 1: ohne Fehler gibt es nichts zu wiederholen', () => {
  assert.equal(kannErneutSchieben('kid-1', null, false), false);
});

test('Befund 1: ohne Kennung (noch nicht gestartet) gibt es nichts zu wiederholen', () => {
  assert.equal(kannErneutSchieben(null, 'Netzwerkfehler', false), false);
});

test('Befund 1: ist der Umzug fertig, verschwindet der Knopf auch bei stehendem Fehlertext', () => {
  assert.equal(kannErneutSchieben('kid-1', 'alter Fehlertext', true), false);
});

test('Befund 3: waehrend eine Kopplung laeuft und noch nichts uebernommen ist, gibt es einen Weg zurueck', () => {
  assert.equal(kannVerwerfen('kid-1', null), true);
});

test('Befund 3: vor der Einloesung gibt es nichts zu verwerfen', () => {
  assert.equal(kannVerwerfen(null, null), false);
});

test('Befund 3: nach erfolgreicher Uebernahme verschwindet der Knopf', () => {
  assert.equal(kannVerwerfen('kid-1', 42), false);
});
