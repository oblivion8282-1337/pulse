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

// Läuft das Web-Bundle vor dem chat-gateway, antwortet FastAPI auf die noch
// fehlende Route mit 404 {"detail":"Not Found"} — das ist keine tote Einladung.
test('ein 404 ohne den Einladungstext ist ein Serverproblem, nicht „ungültig“', () => {
  assert.equal(einladungFehler(404, 'Not Found'), 'netz');
  assert.equal(einladungFehler(404, undefined), 'netz');
});

// GET /c/{handle}: routes/public_community.py antwortet auf einen unbekannten
// oder nicht öffentlichen Handle mit genau diesem Text — auch eine bewusste
// „gibt es nicht“-Antwort, kein Serverproblem.
test('ein 404 „community not found“ ist endgültig „ungültig“', () => {
  assert.equal(einladungFehler(404, 'community not found'), 'ungueltig');
});
