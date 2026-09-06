import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zielFuerAblage, rolleLesen, endeAnstoss } from '../electron/ablageWeiche.ts';

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

test('rolleLesen nimmt beide gueltigen Rollen an', () => {
  assert.equal(rolleLesen('host'), 'host');
  assert.equal(rolleLesen('controller'), 'controller');
});

test('rolleLesen ist fail-closed gegen alles andere', () => {
  // Kein Raten aus der Sitzungsnummer o.ae. — der Renderer muss seine Rolle
  // selbst mitbringen, sonst gilt sie als unbekannt.
  assert.equal(rolleLesen(undefined), null);
  assert.equal(rolleLesen(''), null);
  assert.equal(rolleLesen('Host'), null); // Gross-/Kleinschreibung zaehlt
  assert.equal(rolleLesen({ rolle: 'host' }), null);
});

test('der Ende-Anstoss traegt die Anstoss-Huelle, nicht die Rahmen-Form', () => {
  // Er geht durch dieselbe Tuer wie fremde Nutzlast (`gsr:ablage` bzw.
  // `gsr:ablageEnde`), und `pulse_ablage::lage::deuten` entscheidet an der
  // HUELLE: unter `anstoss` steht Eigenes, unter `rahmen` Fremdes. Eine
  // Rahmen-Form hier bedeutete, dass die Gegenseite dasselbe schicken und die
  // Ablage abschalten koennte.
  assert.deepEqual(endeAnstoss(), { anstoss: 'ende' });
});
