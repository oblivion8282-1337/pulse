import test from 'node:test';
import assert from 'node:assert/strict';
import { einladungFehler } from '../src/lib/einladung/fehlertext.ts';

// Die `detail`-Texte sind die Schnittstelle zum chat-gateway:
// routes/invites.py, guild_caps.py, dcc_shared/token_verify.py.
test('jede Antwort des Servers bekommt ihre eigene Art', () => {
  assert.equal(einladungFehler(404, 'invite invalid or expired'), 'ungueltig');
  assert.equal(einladungFehler(403, 'email verification required'), 'email');
  assert.equal(einladungFehler(403, 'you are banned from this server'), 'ausgeschlossen');
  assert.equal(einladungFehler(403, 'community is suspended'), 'gesperrt');
  assert.equal(einladungFehler(403, 'community member_cap limit reached (50/50)'), 'voll');
  assert.equal(einladungFehler(403, 'join_not_permitted'), 'abgelehnt');
  assert.equal(einladungFehler(429, 'zu viele Anfragen'), 'bremse');
});

test('alles andere ist ein Netz- oder Serverproblem, nie „ungültig“', () => {
  assert.equal(einladungFehler(null, undefined), 'netz');
  assert.equal(einladungFehler(500, 'boom'), 'netz');
  assert.equal(einladungFehler(502, null), 'netz');
  assert.equal(einladungFehler(403, { error: 'x' }), 'abgelehnt');
});
