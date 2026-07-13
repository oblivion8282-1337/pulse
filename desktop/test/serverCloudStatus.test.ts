import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCloudStatus } from '../electron/serverCloudStatus.ts';

test('classifyCloudStatus: 200 + online:true → true (registriert & auffindbar)', () => {
  assert.equal(classifyCloudStatus(200, { online: true }), true);
});

test('classifyCloudStatus: 200 + online:false → false (Heartbeat stale, läuft noch)', () => {
  assert.equal(classifyCloudStatus(200, { online: false }), false);
});

test('classifyCloudStatus: 200 ohne online-Feld → false (nicht online)', () => {
  assert.equal(classifyCloudStatus(200, {}), false);
  assert.equal(classifyCloudStatus(200, null), false);
});

test('classifyCloudStatus: 401 (Session weg) → null (fail-safe)', () => {
  assert.equal(classifyCloudStatus(401, null), null);
});

test('classifyCloudStatus: 404 (keine Membership/kein Eintrag) → null', () => {
  assert.equal(classifyCloudStatus(404, null), null);
});

test('classifyCloudStatus: 5xx → null', () => {
  assert.equal(classifyCloudStatus(500, null), null);
  assert.equal(classifyCloudStatus(503, { online: true }), null); // Status schlägt Body
});

test('classifyCloudStatus: 0 (Transport-/Netzfehler) → null', () => {
  assert.equal(classifyCloudStatus(0, null), null);
});
