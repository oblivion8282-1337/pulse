// desktop/test/localBackend/tunnel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRatholeClientConfig } from '../../electron/localBackend/tunnel.ts';
import { renderEnv } from '../../electron/localBackend/renderConfig.ts';
import { makeDataDirs, FIXTURE_SECRETS, FIXTURE_PORTS } from './fixtures.ts';

test('renderRatholeClientConfig baut die Client-TOML', () => {
  const toml = renderRatholeClientConfig({
    relayServerAddr: 'relay.howispulse.com:2333',
    authToken: 'TKN', localChatPort: 8002, tunnelName: 'inst-42',
  });
  assert.match(toml, /\[client\]/);
  assert.match(toml, /remote_addr = "relay\.howispulse\.com:2333"/);
  assert.match(toml, /default_token = "TKN"/);
  assert.match(toml, /\[client\.services\.inst-42\]/);
  assert.match(toml, /local_addr = "127\.0\.0\.1:8002"/);
});

test('renderEnv nutzt relaySubdomain als public origin', () => {
  const base = { dirs: makeDataDirs('/u'), secrets: FIXTURE_SECRETS,
    ports: FIXTURE_PORTS };
  const env = renderEnv({ ...base, identity: {
    hostname: 'home.internal', instanceId: '42', ownerId: '9',
    relaySubdomain: 'inst-42.relay.howispulse.com' } });
  assert.equal(env.JWT_ISSUER, 'https://inst-42.relay.howispulse.com');
  assert.equal(env.WEBAUTHN_RP_ID, 'inst-42.relay.howispulse.com');
  assert.match(env.CORS_ALLOW_ORIGINS, /inst-42\.relay\.howispulse\.com/);
  // interne DB-URL bleibt localhost:
  assert.match(env.DATABASE_URL, /@127\.0\.0\.1:/);
});
