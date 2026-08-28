import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABLEHNUNGSCODES,
  MELDUNGSSCHLUESSEL,
  VON_SELBST_HEILBAR,
  hatTextFuerJedenCode,
  istAblehnungscode,
} from '../src/lib/api/anmelde-fehler-codes.ts';

test('jeder Ablehnungscode hat einen eigenen Text', () => {
  // Ein Code ohne Meldung ist die Sammelmeldung zurueck — genau das, wogegen
  // dieser Umbau gerichtet ist.
  assert.ok(hatTextFuerJedenCode(), 'mindestens ein Code ohne Meldung');
});

test('die Codeliste deckt ab, was der Server tatsaechlich antwortet', () => {
  // Quelle: ticket_pruefung.py (ticket_*, jwks_cold), gates.py (join_*,
  // "instance banned"), suspend_poller.py (instance_suspended/-deleted).
  for (const c of [
    'ticket_expired',
    'ticket_replayed',
    'ticket_wrong_audience',
    'ticket_wrong_issuer',
    'ticket_wrong_purpose',
    'ticket_invalid',
    'ticket_malformed',
    'jwks_cold',
    'join_locked',
    'join_not_permitted',
    'instance banned',
    'instance_suspended',
    'instance_deleted',
  ]) {
    assert.ok(ABLEHNUNGSCODES.includes(c as never), `${c} fehlt in der Liste`);
  }
});

test('fremde Werte gelten nicht als Code', () => {
  assert.equal(istAblehnungscode('ticket_expired'), true);
  assert.equal(istAblehnungscode('irgendwas'), false);
  assert.equal(istAblehnungscode(null), false);
  assert.equal(istAblehnungscode(42), false);
});

test('von selbst heilbar sind nur die, die keine Handlung verlangen', () => {
  // Ein gebannter Nutzer wird durch Wiederholen nicht entbannt. Wer das
  // vermischt, baut eine Endlosschleife statt einer Fehlermeldung.
  for (const c of VON_SELBST_HEILBAR) {
    assert.ok(ABLEHNUNGSCODES.includes(c), `${c} steht nicht in der Codeliste`);
  }
  assert.ok(!VON_SELBST_HEILBAR.includes('instance banned' as never));
  assert.ok(!VON_SELBST_HEILBAR.includes('join_not_permitted' as never));
  assert.ok(!VON_SELBST_HEILBAR.includes('jwks_cold' as never));
});

test('kein Code zeigt auf einen leeren Schluessel', () => {
  for (const c of ABLEHNUNGSCODES) {
    const k = MELDUNGSSCHLUESSEL[c];
    assert.ok(k && k.startsWith('anmeldung_'), `${c} zeigt auf "${k}"`);
  }
});
