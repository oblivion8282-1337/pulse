import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReachability, isCgnatIp } from '../../electron/localBackend/reachability.ts';

const allOk = { udp: { 7882: true, 8189: true }, tcp: { 7881: true, 1936: true } };
const allBlocked = { udp: { 7882: false, 8189: false }, tcp: { 7881: false, 1936: false } };

test('isCgnatIp erkennt 100.64.0.0/10', () => {
  assert.equal(isCgnatIp('100.64.1.2'), true);
  assert.equal(isCgnatIp('100.127.255.255'), true);
  assert.equal(isCgnatIp('100.63.255.255'), false);  // knapp außerhalb
  assert.equal(isCgnatIp('203.0.113.5'), false);
});

test('reachable wenn Public-IP normal + alle Pflicht-Ports erreichbar', () => {
  assert.equal(classifyReachability('203.0.113.5', allOk), 'reachable');
});

test('cgnat bei 100.64/10 — unabhängig vom Probe', () => {
  assert.equal(classifyReachability('100.70.0.1', allOk), 'cgnat');
});

test('needs-forwarding bei normaler IP + blockierten Ports', () => {
  assert.equal(classifyReachability('203.0.113.5', allBlocked), 'needs-forwarding');
});

test('unknown ohne STUN-IP oder ohne Probe', () => {
  assert.equal(classifyReachability(null, allOk), 'unknown');
  assert.equal(classifyReachability('203.0.113.5', null), 'unknown');
});
