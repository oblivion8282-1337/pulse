import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHwdecWacht, istAbbruch } from '../electron/player-hwdec-wacht.ts';

test('SIGABRT ist der Sturz, um den es geht', () => {
  assert.equal(istAbbruch(null, 'SIGABRT'), true);
});

test('auch der durchgereichte Beendigungscode 134 zaehlt', () => {
  // Ueber einen Zwischenwirt (Flatpak-Wrapper, `sh -c`) kommt kein Signal mehr
  // an, nur noch 128+SIGABRT als Zahl.
  assert.equal(istAbbruch(134, null), true);
});

test('normale Enden loesen nichts aus', () => {
  // Sauberes Ende, unser eigenes Herunterfahren, ein Startfehler: alles ohne
  // Bezug zur Dekodierung. Wuerden sie greifen, verloere jeder gewoehnliche
  // Fensterschluss die Hardware-Dekodierung fuer den Rest des App-Laufs.
  assert.equal(istAbbruch(0, null), false);
  assert.equal(istAbbruch(1, null), false);
  assert.equal(istAbbruch(null, 'SIGTERM'), false);
  assert.equal(istAbbruch(null, 'SIGKILL'), false);
  assert.equal(istAbbruch(null, null), false);
});

test('vor dem ersten Sturz bleibt die Hardware an', () => {
  const w = createHwdecWacht();
  assert.equal(w.hardwareAbgeschaltet(), false);
});

test('ein Sturz schaltet ab und meldet sich genau einmal', () => {
  const w = createHwdecWacht();
  assert.equal(w.absturzGemeldet(null, 'SIGABRT'), true);
  assert.equal(w.hardwareAbgeschaltet(), true);
  // Zweiter Sturz: nichts mehr abzuschalten, also auch keine zweite Meldung —
  // sonst stuende bei wiederholtem Aufmachen dieselbe Zeile im Log und
  // suggerierte einen neuen Befund.
  assert.equal(w.absturzGemeldet(null, 'SIGABRT'), false);
  assert.equal(w.hardwareAbgeschaltet(), true);
});

test('ein gewoehnliches Ende nach dem Sturz nimmt den Rueckfall nicht zurueck', () => {
  // Der haeufigste Ablauf ueberhaupt: Sturz, Rueckfall, danach macht der Nutzer
  // das Fenster irgendwann normal zu. Wuerde das den Rueckfall aufheben, kaeme
  // der Sturz beim naechsten Oeffnen sofort wieder.
  const w = createHwdecWacht();
  w.absturzGemeldet(null, 'SIGABRT');
  assert.equal(w.absturzGemeldet(0, null), false);
  assert.equal(w.hardwareAbgeschaltet(), true);
});
