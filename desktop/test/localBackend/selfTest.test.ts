import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SELFTEST_TCP_PORTS, portGroups, classifySelfTest, runSelfTest,
} from '../../electron/localBackend/selfTest.ts';

// Portlisten-Mapping → Klartext-Gruppen

test('portGroups: Voice-Ports (7881 + 7882-7892)', () => {
  assert.deepEqual(portGroups([7881]), ['Voice']);
  assert.deepEqual(portGroups([7882]), ['Voice']);
  assert.deepEqual(portGroups([7892]), ['Voice']);
});

test('portGroups: Streaming-Ports (1936 + 8189)', () => {
  assert.deepEqual(portGroups([1936]), ['Streaming']);
  assert.deepEqual(portGroups([8189]), ['Streaming']);
});

test('portGroups: Verbindungsaufbau (3478 + 7900)', () => {
  assert.deepEqual(portGroups([3478]), ['Verbindungsaufbau']);
  assert.deepEqual(portGroups([7900]), ['Verbindungsaufbau']);
});

test('portGroups: dedupliziert + stabile Reihenfolge (Voice vor Streaming vor Verbindungsaufbau)', () => {
  assert.deepEqual(portGroups([7900, 1936, 8189, 7882, 7883]), ['Voice', 'Streaming', 'Verbindungsaufbau']);
  assert.deepEqual(portGroups([]), []);
  assert.deepEqual(portGroups([9999]), []); // unbekannter Port → keine Gruppe
});

// Klassifikation

test('classifySelfTest: null (Prüfung nicht möglich) → unavailable, kein Alarm', () => {
  assert.deepEqual(classifySelfTest(null), { status: 'unavailable', failedPorts: [], groups: [] });
});

test('classifySelfTest: alle Ports erreichbar → ok', () => {
  const tcp = Object.fromEntries(SELFTEST_TCP_PORTS.map((p) => [p, true]));
  const r = classifySelfTest(tcp);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.failedPorts, []);
  assert.deepEqual(r.groups, []);
});

test('classifySelfTest: 1936 blockiert → blocked + Gruppe Streaming', () => {
  const r = classifySelfTest({ 1936: false });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.failedPorts, [1936]);
  assert.deepEqual(r.groups, ['Streaming']);
});

// runSelfTest — I/O-Orchestrierung mit injizierten Deps

const OK_IP = async () => '203.0.113.7';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

test('runSelfTest: TCP erreichbar → ok', async () => {
  const r = await runSelfTest({
    probeUrl: 'https://x/probe', discoverIp: OK_IP,
    fetchImpl: fakeFetch(200, { tcp: { '1936': true } }),
  });
  assert.equal(r.status, 'ok');
});

test('runSelfTest: TCP blockiert → blocked + Streaming', async () => {
  const r = await runSelfTest({
    probeUrl: 'https://x/probe', discoverIp: OK_IP,
    fetchImpl: fakeFetch(200, { tcp: { '1936': false } }),
  });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.groups, ['Streaming']);
});

test('runSelfTest: Dienst antwortet non-2xx → unavailable (fail-safe)', async () => {
  const r = await runSelfTest({
    probeUrl: 'https://x/probe', discoverIp: OK_IP,
    fetchImpl: fakeFetch(400, { detail: 'port not allowed' }),
  });
  assert.equal(r.status, 'unavailable');
});

test('runSelfTest: fetch wirft (Netzwerkfehler) → unavailable, kein throw', async () => {
  const r = await runSelfTest({
    probeUrl: 'https://x/probe', discoverIp: OK_IP,
    fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
  });
  assert.equal(r.status, 'unavailable');
});

test('runSelfTest: keine Public-IP (STUN down) → unavailable', async () => {
  const r = await runSelfTest({ probeUrl: 'https://x/probe', discoverIp: async () => null });
  assert.equal(r.status, 'unavailable');
});
