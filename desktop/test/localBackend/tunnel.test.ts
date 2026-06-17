// desktop/test/localBackend/tunnel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderRatholeClientConfig, tunnelComponent } from '../../electron/localBackend/tunnel.ts';
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

test('tunnelComponent baut Spec und schreibt TOML', () => {
  const root = join(tmpdir(), `tunnel-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  try {
    const dirs = makeDataDirs(root);
    const relay = {
      serverAddr: 'relay.howispulse.com:2333',
      authToken: 'SECRET',
      subdomain: 'inst-99.relay.howispulse.com',
    };
    const spec = tunnelComponent({ dirs, relay, chatPort: 55544 });

    // Spec-Prüfung
    assert.equal(spec.name, 'tunnel');
    assert.ok(spec.command.includes('rathole'), `command "${spec.command}" soll rathole enthalten`);
    assert.deepEqual(spec.args[0], '--client');

    // TOML wurde geschrieben
    const tomlPath = join(root, 'rathole-client.toml');
    assert.ok(existsSync(tomlPath), 'rathole-client.toml muss existieren');
    const content = readFileSync(tomlPath, 'utf8');
    assert.match(content, /\[client\]/);
    assert.match(content, /\[client\.services\./);
    assert.match(content, /local_addr = "127\.0\.0\.1:55544"/);
    // Token wird NICHT ins Log geschrieben — nur indirekt via TOML; kein Assert auf Logs nötig
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
