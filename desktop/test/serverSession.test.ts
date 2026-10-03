/**
 * serverSession — Pulse-Session-Cookie-Parser (reine Helper, kein Electron).
 *
 * Regressions-Schutz für den Bughunt 2026-10-03: der Bearer-Renew der
 * Server-App muss das neu gemintete pulse_session aus den Set-Cookie-Headern
 * eines `net`-Renews lesen können (Electron `net` speichert ohne
 * `useSessionCookies` kein Set-Cookie selbst) — und dabei andere Cookies
 * (pulse_rt) und Lösch-Hinweise (leerer Wert) zuverlässig überspringen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pulseSessionAusSetCookie } from '../electron/serverSession.ts';

test('liest pulse_session mit Max-Age aus der Antwort', () => {
  const kopf = [
    'pulse_session=abc-123; Max-Age=1800; Path=/; HttpOnly; SameSite=strict; Secure',
  ];
  assert.deepEqual(pulseSessionAusSetCookie(kopf), { value: 'abc-123', maxAgeSek: 1800 });
});

test('überspringt andere Cookies (pulse_rt zuerst) und findet pulse_session', () => {
  const kopf = [
    'pulse_rt=eyJhbGciOi.eyJzdWIi.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=strict; Secure',
    'pulse_session=fb6dbe26-3d99-41d5-a085-9e55c03555f9; Max-Age=900; Path=/',
  ];
  assert.deepEqual(pulseSessionAusSetCookie(kopf), {
    value: 'fb6dbe26-3d99-41d5-a085-9e55c03555f9',
    maxAgeSek: 900,
  });
});

test('ohne Max-Age gilt der Server-Default 1800', () => {
  const kopf = ['pulse_session=xyz; Path=/'];
  assert.deepEqual(pulseSessionAusSetCookie(kopf), { value: 'xyz', maxAgeSek: 1800 });
});

test('Lösch-Hinweis (leerer Wert) und fremde Cookies → null', () => {
  assert.equal(pulseSessionAusSetCookie(['pulse_session=; Max-Age=0; Path=/']), null);
  assert.equal(pulseSessionAusSetCookie(['pulse_rt=abc; Max-Age=60']), null);
});

test('fehlende/kaputte Header → null statt Wurf', () => {
  assert.equal(pulseSessionAusSetCookie(undefined), null);
  assert.equal(pulseSessionAusSetCookie([]), null);
  assert.equal(pulseSessionAusSetCookie(['gib-garkein-gleichzeichen']), null);
});
