import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeleteStatus, runGiveUp, type GiveUpOps,
} from '../electron/serverGiveUp.ts';

// Cloud-Delete-Klassifikation

test('classifyDeleteStatus: 204 → ok, 404 (schon gelöscht) → ok', () => {
  assert.equal(classifyDeleteStatus(204), 'ok');
  assert.equal(classifyDeleteStatus(404), 'ok');
});
test('classifyDeleteStatus: 401/403 → unauthorized (Client-Weg-Hinweis)', () => {
  assert.equal(classifyDeleteStatus(401), 'unauthorized');
  assert.equal(classifyDeleteStatus(403), 'unauthorized');
});
test('classifyDeleteStatus: 5xx/Transportfehler → error', () => {
  assert.equal(classifyDeleteStatus(500), 'error');
  assert.equal(classifyDeleteStatus(0), 'error');
});

// Schritt-Sequenz

function fakeOps(calls: string[], over: Partial<GiveUpOps> = {}): GiveUpOps {
  return {
    removeContainer: async () => { calls.push('container'); },
    deleteCloudRegistration: async () => { calls.push('cloud'); return 'ok'; },
    removeAutostart: () => { calls.push('autostart'); },
    clearPairing: () => { calls.push('pairing'); },
    removeDataVolume: async () => { calls.push('volume'); return true; },
    ...over,
  };
}

test('runGiveUp ohne deleteData: Volume bleibt, Reihenfolge container→cloud→autostart→pairing', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: false, skipCloud: false }, fakeOps(calls));
  assert.deepEqual(calls, ['container', 'cloud', 'autostart', 'pairing']);
  assert.deepEqual(r, { ok: true, cloudDeleted: true, dataDeleted: null, errors: [] });
});

test('runGiveUp mit deleteData: Volume-rm NACH Container-rm', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: true, skipCloud: false }, fakeOps(calls));
  assert.deepEqual(calls, ['container', 'cloud', 'autostart', 'pairing', 'volume']);
  assert.equal(r.dataDeleted, true);
});

test('runGiveUp skipCloud (superseded): Cloud-Op wird nie gerufen, cloudDeleted null', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: true, skipCloud: true }, fakeOps(calls));
  assert.equal(calls.includes('cloud'), false);
  assert.equal(r.cloudDeleted, null);
});

test('runGiveUp: Cloud unauthorized → cloudDeleted false, Rest läuft trotzdem durch', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: false, skipCloud: false }, fakeOps(calls, {
    deleteCloudRegistration: async () => { calls.push('cloud'); return 'unauthorized'; },
  }));
  assert.equal(r.cloudDeleted, false);
  assert.deepEqual(calls, ['container', 'cloud', 'autostart', 'pairing']);
  assert.ok(r.errors.some((e) => e.startsWith('cloud:')));
});

test('runGiveUp: Volume-rm scheitert → dataDeleted false + Fehler, ok bleibt true, Pairing weg', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: true, skipCloud: false }, fakeOps(calls, {
    removeDataVolume: async () => { calls.push('volume'); return false; },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.dataDeleted, false);
  assert.ok(calls.includes('pairing'));
  assert.ok(r.errors.some((e) => e.startsWith('volume:')));
});

test('runGiveUp: Container-Op wirft → best-effort weiter, Fehler dokumentiert', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: false, skipCloud: false }, fakeOps(calls, {
    removeContainer: async () => { throw new Error('rm failed'); },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['cloud', 'autostart', 'pairing']);
  assert.ok(r.errors.some((e) => e.startsWith('container:')));
});

test('runGiveUp: Cloud-Op wirft → wie error behandelt, kein throw nach außen', async () => {
  const calls: string[] = [];
  const r = await runGiveUp({ deleteData: false, skipCloud: false }, fakeOps(calls, {
    deleteCloudRegistration: async () => { throw new Error('offline'); },
  }));
  assert.equal(r.cloudDeleted, false);
  assert.ok(calls.includes('pairing'));
});
