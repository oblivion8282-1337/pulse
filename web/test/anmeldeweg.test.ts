import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAEHIGKEIT_TICKET, waehleAnmeldeweg } from '../src/lib/servers/anmeldeweg.ts';

test('kennt der Server den Ticket-Weg, wird er genommen', () => {
  assert.equal(waehleAnmeldeweg(['token_refresh', 'server-ticket']), 'ticket');
});

test('ein alter Server bekommt weiter den Zertifikats-Weg', () => {
  assert.equal(waehleAnmeldeweg(['token_refresh']), 'zertifikat');
});

test('noch keine Auskunft heisst Zertifikat, nicht Ticket', () => {
  // Vor dem ersten hello wissen wir nichts. Der alte Weg funktioniert ueberall,
  // der neue nur auf neuen Servern — im Zweifel also der, der immer geht.
  assert.equal(waehleAnmeldeweg(null), 'zertifikat');
  assert.equal(waehleAnmeldeweg([]), 'zertifikat');
  assert.equal(waehleAnmeldeweg(undefined), 'zertifikat');
});

test('die Kennung der Faehigkeit steht genau einmal', () => {
  // Sie muss mit routes/ws.py uebereinstimmen. Ein Tippfehler hier faellt sonst
  // erst auf, wenn niemand mehr den neuen Weg bekommt — und zwar lautlos, weil
  // der Rueckfall auf den alten Weg voellig normal aussieht.
  assert.equal(FAEHIGKEIT_TICKET, 'server-ticket');
  assert.equal(waehleAnmeldeweg([FAEHIGKEIT_TICKET]), 'ticket');
});
