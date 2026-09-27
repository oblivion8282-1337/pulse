import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegistryTokenStatus, checkCredsSupersede,
  classifyDeletedList, checkInstanceDeleted,
} from '../electron/serverSupersede.ts';
import type { BootstrapCreds } from '../electron/localBackend/pairing.ts';

const CREDS: Pick<BootstrapCreds, 'cloudOrigin' | 'clientId' | 'clientSecret'> = {
  cloudOrigin: 'https://howispulse.com', clientId: 'cid', clientSecret: 'SECRET',
};

function fakeFetch(status: number): typeof fetch {
  return (async () => ({ status })) as unknown as typeof fetch;
}

function throwingFetch(err: Error): typeof fetch {
  return (async () => { throw err; }) as unknown as typeof fetch;
}

test('classifyRegistryTokenStatus: 401 → superseded', () => {
  assert.equal(classifyRegistryTokenStatus(401), 'superseded');
});
test('classifyRegistryTokenStatus: 2xx → valid', () => {
  assert.equal(classifyRegistryTokenStatus(200), 'valid');
});
test('classifyRegistryTokenStatus: 403 (suspendiert, kein Ablöse-Beweis) → unknown', () => {
  assert.equal(classifyRegistryTokenStatus(403), 'unknown');
});
test('classifyRegistryTokenStatus: 5xx → unknown', () => {
  assert.equal(classifyRegistryTokenStatus(503), 'unknown');
});
test('classifyRegistryTokenStatus: kein Status (Netzwerkfehler) → unknown', () => {
  assert.equal(classifyRegistryTokenStatus(null), 'unknown');
});

test('checkCredsSupersede: 401 → superseded', async () => {
  assert.equal(await checkCredsSupersede(CREDS, fakeFetch(401)), 'superseded');
});
test('checkCredsSupersede: 200 → valid', async () => {
  assert.equal(await checkCredsSupersede(CREDS, fakeFetch(200)), 'valid');
});
test('checkCredsSupersede: Netzwerkfehler (fetch wirft) → unknown, kein throw', async () => {
  assert.equal(
    await checkCredsSupersede(CREDS, throwingFetch(new Error('ECONNREFUSED'))),
    'unknown',
  );
});
test('checkCredsSupersede: Basic-Auth-Header korrekt gebaut', async () => {
  let seenAuth: string | null = null;
  const fetchImpl = (async (_url: string, opts: { headers: Record<string, string> }) => {
    seenAuth = opts.headers.Authorization;
    return { status: 200 };
  }) as unknown as typeof fetch;
  await checkCredsSupersede(CREDS, fetchImpl);
  assert.equal(seenAuth, `Basic ${Buffer.from('cid:SECRET').toString('base64')}`);
});

// ── Gelöschte Instanz (öffentliche Suspend-/Delete-Liste) ────────────────────
const DEL_CREDS = { cloudOrigin: 'https://howispulse.com', instanceId: '69047386697109504' };

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })) as unknown as typeof fetch;
}

test('classifyDeletedList: Instanz in deleted_instance_ids → true', () => {
  assert.equal(classifyDeletedList('69047386697109504', {
    instance_ids: ['69047386697109504'], deleted_instance_ids: ['69047386697109504'],
  }), true);
});
test('classifyDeletedList: nur suspendiert (nicht in deleted) → false', () => {
  assert.equal(classifyDeletedList('123', {
    instance_ids: ['123'], deleted_instance_ids: ['456'],
  }), false);
});
test('classifyDeletedList: kaputter/leerer Body → false (fail-safe)', () => {
  assert.equal(classifyDeletedList('123', null), false);
  assert.equal(classifyDeletedList('123', 'garbage'), false);
  assert.equal(classifyDeletedList('123', { deleted_instance_ids: 'nope' }), false);
});

test('checkInstanceDeleted: gelöschte Instanz → true', async () => {
  const body = { deleted_instance_ids: ['69047386697109504'] };
  assert.equal(await checkInstanceDeleted(DEL_CREDS, jsonFetch(200, body)), true);
});
test('checkInstanceDeleted: nicht gelistet → false', async () => {
  assert.equal(await checkInstanceDeleted(DEL_CREDS, jsonFetch(200, { deleted_instance_ids: [] })), false);
});
test('checkInstanceDeleted: HTTP-Fehler/Netzfehler → false (fail-safe)', async () => {
  assert.equal(await checkInstanceDeleted(DEL_CREDS, jsonFetch(503, null)), false);
  assert.equal(await checkInstanceDeleted(DEL_CREDS, throwingFetch(new Error('offline'))), false);
});
