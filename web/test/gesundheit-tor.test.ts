/**
 * Das Tor, das die Standplatz-Anmeldung auf die erste Health-Messung warten
 * lässt (`src/lib/stream/gesundheitTor.ts`).
 *
 * Geprüft wird vor allem die Eigenschaft, an der der Fehler vom 2026-08-26
 * hing: ein Wartender darf nicht stehenbleiben, und er darf nicht zu früh
 * loslaufen. Beides ist im laufenden Programm schwer zu sehen — das Rennen
 * entscheidet sich in Millisekunden und geht meistens gleich aus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { macheGesundheitTor } from '../src/lib/stream/gesundheitTor.ts';

test('ein frisches Tor ist zu', () => {
  const tor = macheGesundheitTor();
  assert.equal(tor.offen(), false);
});

test('wer vor dem Öffnen wartet, läuft erst danach los', async () => {
  const tor = macheGesundheitTor();
  let gelaufen = false;
  const wartend = tor.bekannt().then(() => {
    gelaufen = true;
  });

  // Eine Runde durch die Ereignisschleife, ohne das Tor zu öffnen: der
  // Wartende darf sich bis hierhin NICHT gerührt haben.
  await Promise.resolve();
  assert.equal(gelaufen, false, 'ist losgelaufen, bevor gemessen wurde');

  tor.oeffnen();
  await wartend;
  assert.equal(gelaufen, true);
});

test('wer nach dem Öffnen wartet, läuft sofort los', async () => {
  const tor = macheGesundheitTor();
  tor.oeffnen();
  await tor.bekannt();
  assert.equal(tor.offen(), true);
});

test('mehrfaches Öffnen ist harmlos', async () => {
  const tor = macheGesundheitTor();
  tor.oeffnen();
  tor.oeffnen();
  tor.oeffnen();
  await tor.bekannt();
  assert.equal(tor.offen(), true);
});

test('mehrere Wartende laufen alle los', async () => {
  const tor = macheGesundheitTor();
  const zaehler: number[] = [];
  const alle = [1, 2, 3].map((n) => tor.bekannt().then(() => zaehler.push(n)));
  tor.oeffnen();
  await Promise.all(alle);
  assert.deepEqual(zaehler.sort(), [1, 2, 3]);
});

test('zwei Tore sind unabhängig', () => {
  // Der Grund für die Fabrik: ein Modul-Singleton liesse sich nur einmal
  // schliessen, und ein Test könnte den geschlossenen Zustand nie zweimal
  // prüfen.
  const eins = macheGesundheitTor();
  const zwei = macheGesundheitTor();
  eins.oeffnen();
  assert.equal(eins.offen(), true);
  assert.equal(zwei.offen(), false);
});
