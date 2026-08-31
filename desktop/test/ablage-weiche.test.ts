import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zielFuerAblage } from '../electron/ablageWeiche.ts';

test('der Steuernde haelt seine Ablage im Player', () => {
  // Beim Steuernden laeuft KEIN Sidecar — nur das Player-Fenster. Waere die
  // Weiche hier falsch, ginge jeder Rahmen an einen Prozess, den es nicht
  // gibt, und die Ablage bliebe stumm.
  assert.equal(zielFuerAblage('controller'), 'player');
});

test('der Host haelt sie im Sidecar', () => {
  // Beim Host ist das Player-Fenster gar nicht offen; die Ablage gehoert dem
  // Prozess, der auch die Eingabe injiziert.
  assert.equal(zielFuerAblage('host'), 'sidecar');
});
