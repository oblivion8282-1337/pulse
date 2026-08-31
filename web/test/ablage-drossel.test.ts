import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Drossel,
  STUECKE_JE_LIEFERUNG,
  STUECKE_PRO_SEKUNDE,
} from '../src/lib/remote/ablageDrossel.ts';

/** Der Deckel des Gateways, an dem sich alles hier misst — Spiegelzahl aus
 *  `ws_remote_handlers.py::handle_signal`. */
const GATEWAY_DECKEL = 60;

test('die Drossel bleibt unter dem Sekundendeckel des Gateways', () => {
  // Der Gateway verwirft ueber 60 Signale je Sekunde STILL. Auf demselben
  // Zaehler sitzen Zeigerform und Vorrang; deshalb nimmt die Ablage nur die
  // Haelfte. Ein Schwall verschwaende sonst spurlos und saehe wie ein
  // Netzfehler aus.
  assert.ok(STUECKE_PRO_SEKUNDE <= 30, `${STUECKE_PRO_SEKUNDE} laesst dem Rest keinen Platz`);
  const d = new Drossel();
  let durch = 0;
  for (let i = 0; i < 200; i++) if (d.darf(1000 + i)) durch++;
  // Die Nachsicht darf den Gateway-Deckel nicht ausreizen: sie ist dafuer da,
  // eine Lieferung nicht in der Mitte zu zerschneiden, nicht dafuer, mehr zu
  // senden.
  assert.ok(
    durch <= STUECKE_PRO_SEKUNDE + STUECKE_JE_LIEFERUNG,
    `${durch} in einer Sekunde durchgelassen`,
  );
  assert.ok(durch < GATEWAY_DECKEL, `${durch} kommt dem Gateway-Deckel zu nahe`);
});

test('eine ganze Lieferung wird nie in der Mitte zerschnitten', () => {
  // **Der Grund fuer die Nachsicht.** Faellt ein einzelnes Stueck, ist nicht
  // ein Stueck weg, sondern die ganze Lieferung: der Sammler drueben wartet
  // auf eines, das nie kommt, bis ABRUF_FRIST_MS (2 s) ablaeuft — und auf
  // Windows und macOS steht das einfuegende Programm diese 2 s.
  const d = new Drossel();
  // Das Fenster ist schon voll (etwa durch einen vorigen Abruf).
  for (let i = 0; i < STUECKE_PRO_SEKUNDE; i++) assert.equal(d.darf(1000), true);
  for (let i = 0; i < STUECKE_JE_LIEFERUNG; i++) {
    assert.equal(d.darf(1000), true, `Stueck ${i} der Lieferung faellt`);
  }
});

test('die Nachsicht ist geliehen, nicht geschenkt', () => {
  // Sonst laege der Mittelwert dauerhaft ueber der Grenze, und der
  // Gateway-Deckel waere nur eine Frage der Dauer.
  const d = new Drossel();
  let erstes = 0;
  for (let i = 0; i < 200; i++) if (d.darf(1000)) erstes++;
  assert.equal(erstes, STUECKE_PRO_SEKUNDE + STUECKE_JE_LIEFERUNG);
  let zweites = 0;
  for (let i = 0; i < 200; i++) if (d.darf(2000)) zweites++;
  assert.equal(
    zweites,
    STUECKE_PRO_SEKUNDE,
    'der Vorschuss muss dem naechsten Fenster abgezogen werden',
  );
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
  // Ohne Nachsicht, damit hier wirklich die UHR geprueft wird und nicht der
  // Vorschuss.
  const d = new Drossel(2, 0);
  assert.equal(d.darf(0), true);
  assert.equal(d.darf(0), true);
  assert.equal(d.darf(0), false);
  assert.equal(d.darf(1000), true);
});
