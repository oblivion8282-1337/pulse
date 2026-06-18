import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redeemBootstrap, credsToIdentity, credsToRelay, probeUrl, sanitize,
  loadCreds, saveCreds, clearCreds, HOST_CREDS_KEY, type BootstrapCreds,
} from '../../electron/localBackend/pairing.ts';

const SAMPLE = {
  instance_id: '123', owner_user_id: '7', hostname: 'mein-pc',
  client_id: 'cid', client_secret: 'SECRET', cloud_origin: 'https://howispulse.com',
  admin_email: 'a@b.c', relay_subdomain: 'brave-otter-4f2a.relay.howispulse.com',
  relay_server_addr: 'relay.howispulse.com:2333', relay_tunnel_token: 'plse_relay_x',
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

test('redeemBootstrap maps snake_case → camelCase creds', async () => {
  const c = await redeemBootstrap('plse_boot_x', 'https://howispulse.com', fakeFetch(200, SAMPLE));
  assert.equal(c.instanceId, '123');
  assert.equal(c.ownerId, '7');
  assert.equal(c.clientSecret, 'SECRET');
  assert.equal(c.relaySubdomain, 'brave-otter-4f2a.relay.howispulse.com');
});

test('redeemBootstrap throws on non-ok', async () => {
  await assert.rejects(() => redeemBootstrap('t', 'https://x', fakeFetch(401, { detail: 'consumed' })));
});

test('credsToIdentity / credsToRelay / probeUrl', () => {
  const c = { ...SAMPLE } as unknown as BootstrapCreds;
  // build a real camelCase creds via redeem-shape:
  const creds: BootstrapCreds = {
    instanceId: '123', ownerId: '7', hostname: 'mein-pc', clientId: 'cid',
    clientSecret: 'S', cloudOrigin: 'https://howispulse.com',
    relaySubdomain: 'sub.relay.x', relayServerAddr: 'relay.x:2333', relayTunnelToken: 'plse_relay_x',
  };
  assert.deepEqual(credsToIdentity(creds), { hostname: 'mein-pc', instanceId: '123', ownerId: '7', relaySubdomain: 'sub.relay.x' });
  assert.deepEqual(credsToRelay(creds), { serverAddr: 'relay.x:2333', authToken: 'plse_relay_x', subdomain: 'sub.relay.x' });
  assert.equal(probeUrl(creds), 'https://howispulse.com/api/auth/selfhost/reachability/probe');
  void c;
});

test('credsToRelay returns undefined without relay fields', () => {
  const creds = { instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 'S', cloudOrigin: 'https://x', relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null } as BootstrapCreds;
  assert.equal(credsToRelay(creds), undefined);
});

test('sanitize never leaks secrets', () => {
  const creds = { instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 'SECRET', cloudOrigin: 'https://x', relaySubdomain: 'sub', relayServerAddr: 'a', relayTunnelToken: 'plse_relay_SECRET' } as BootstrapCreds;
  const s = sanitize(creds);
  assert.equal(s.paired, true);
  assert.equal(JSON.stringify(s).includes('SECRET'), false);
  assert.deepEqual(sanitize(null), { paired: false });
});

test('saveCreds → loadCreds round-trip + clearCreds', () => {
  const mem = new Map<string, unknown>();
  const store = { get: (k: string) => mem.get(k), set: (k: string, v: unknown) => void mem.set(k, v) };
  const creds = { instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 'S', cloudOrigin: 'https://x', relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null } as BootstrapCreds;
  saveCreds(store, creds);
  assert.deepEqual(loadCreds(store), creds);
  clearCreds(store);
  assert.equal(loadCreds(store), null);
});

void HOST_CREDS_KEY; // ensure export is present
