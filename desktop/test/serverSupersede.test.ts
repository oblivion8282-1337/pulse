import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegistryTokenStatus, checkCredsSupersede,
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
