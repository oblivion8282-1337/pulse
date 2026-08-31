import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drossel, STUECKE_PRO_SEKUNDE } from '../src/lib/remote/ablageDrossel.ts';

test('die Drossel bleibt unter dem Sekundendeckel des Gateways', () => {
  // Der Gateway verwirft ueber 60 Signale je Sekunde STILL. Auf demselben
  // Zaehler sitzen Zeigerform und Vorrang; deshalb nimmt die Ablage nur die
  // Haelfte. Ein Schwall verschwaende sonst spurlos und saehe wie ein
  // Netzfehler aus.
  assert.ok(STUECKE_PRO_SEKUNDE <= 30, `${STUECKE_PRO_SEKUNDE} laesst dem Rest keinen Platz`);
  const d = new Drossel();
  let durch = 0;
  for (let i = 0; i < 200; i++) if (d.darf(1000 + i)) durch++;
  assert.ok(durch <= STUECKE_PRO_SEKUNDE, `${durch} in einer Sekunde durchgelassen`);
});

test('nach der Sekunde geht es weiter', () => {
  const d = new Drossel();
  for (let i = 0; i < 200; i++) d.darf(1000 + i);
  assert.equal(d.darf(2500), true, 'ein neues Fenster muss wieder oeffnen');
});

test('die Drossel misst an der uebergebenen Zeit, nicht an der Uhr', () => {
  // Wichtig fuer die Pruefbarkeit UND fuer den Betrieb: Chromium drosselt
  // Zeitgeber in verdeckten Fenstern auf einen Lauf je Minute. Wer hier
  // `Date.now()` selbst riefe, haette im verdeckten Player-Fenster eine
  // Drossel, die nie oeffnet.
  const d = new Drossel(2);
  assert.equal(d.darf(0), true);
  assert.equal(d.darf(0), true);
  assert.equal(d.darf(0), false);
  assert.equal(d.darf(1000), true);
});
