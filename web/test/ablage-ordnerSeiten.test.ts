import { test } from 'node:test';
import assert from 'node:assert/strict';

import { naechsterCursor, fertig } from '../src/lib/ablage/ordnerSeiten.ts';

test('naechsterCursor liefert die Nutzlast-ID, NICHT den Dateinamen', () => {
  // Der Befund C1: der Klient reichte "3.puls" als `nach` weiter, der Server
  // liest `nach` als Zahl.
  assert.equal(naechsterCursor(['1.puls', '2.puls', '3.puls']), '3');
});

test('naechsterCursor nimmt den LETZTEN Namen, nicht den groessten String', () => {
  // Aufsteigend sortiert liegt die hoechste ID hinten — als Zeichenkette
  // waere "9" groesser als "10".
  assert.equal(naechsterCursor(['9.puls', '10.puls']), '10');
});

test('naechsterCursor ueberspringt einen Fremdnamen am Ende', () => {
  assert.equal(naechsterCursor(['7.puls', 'liesmich.txt']), '7');
});

test('naechsterCursor ist null, wenn die Seite keinen brauchbaren Namen hat', () => {
  // Der Aufrufer muss dann abbrechen — mit dem alten Cursor weiterzumachen
  // waere die Endlosschleife.
  assert.equal(naechsterCursor([]), null);
  assert.equal(naechsterCursor(['liesmich.txt']), null);
});

test('fertig meldet die letzte Seite an der Fuellhoehe', () => {
  assert.equal(fertig(['1.puls'], 2), true);
  assert.equal(fertig(['1.puls', '2.puls'], 2), false);
  assert.equal(fertig([], 2), true);
});
