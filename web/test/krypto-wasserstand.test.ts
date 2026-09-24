import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wasserstandEntscheidung, type Wasserstand } from '../src/lib/krypto/gruppe/wasserstand.ts';

/** Die Wiedereinspiel-Entscheidung ist der einzige Schutz, der einen
 *  Megolm-Geheimtext unter NEUER Zustellungs-ID erkennt — `verlaufSchonAbgelegt`
 *  sieht nur die vom Server vergebene Kennung, und genau die setzt der
 *  Angreifer frei. Der Stand-Abriss-Fall (Absturz zwischen Öffnen und
 *  Ablegen) darf desshalb NICHT als Angriff gelten: dieselbe Zustellungs-ID
 *  muss erneut geöffnet werden dürfen, sonst frisst der Schutz selbst
 *  Nachrichten. */

const STAND: Wasserstand = { zaehler: 5, zustellung: 'z-42' };

test('neuer Zaehlerstand wird geöffnet und hebt den Wasserstand', () => {
  assert.equal(wasserstandEntscheidung(null, 0, 'z-1'), 'ok');
  assert.equal(wasserstandEntscheidung(STAND, 6, 'z-99'), 'ok');
});

test('aelterer Zaehler unter neuer Zustellungs-ID ist Wiedereinspiel', () => {
  // Der Angriff: derselbe Geheimtext (Zaehler 3) unter frisch vergebener
  // Zustellungs-Kennung — verwerfen, auch nach einem Neustart (der Stand
  // liegt neustartfest in IndexedDB).
  assert.equal(wasserstandEntscheidung(STAND, 3, 'z-777'), 'wiedereinspiel');
  assert.equal(wasserstandEntscheidung(STAND, 5, 'z-777'), 'wiedereinspiel');
});

test('dieselbe Zustellungs-ID ist die eigene Wiederholung, kein Angriff', () => {
  // Absturz-Fenster: geoeffnet, Wasserstand geschrieben, Ablegen/Quittieren
  // nicht durch — die Zustellung bleibt im Postfach und kommt erneut. Sie
  // muss erneut geoeffnet werden duerfen (Ablegen folgt dann), sonst haette
  // der Schutz hier selbst Nachrichten vernichtet.
  assert.equal(wasserstandEntscheidung(STAND, 5, 'z-42'), 'eigene_wiederholung');
});
