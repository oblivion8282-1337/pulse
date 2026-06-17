import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFrpcConfig, tunnelComponent } from '../../electron/localBackend/tunnel.ts';
import { makeDataDirs } from './fixtures.ts';

test('renderFrpcConfig baut die frpc-TOML mit Subdomain + Token-Metadata', () => {
  const toml = renderFrpcConfig({
    relayServerAddr: 'relay.howispulse.com:7000',
    authToken: 'plse_relay_x', localChatPort: 8002,
    fullSubdomain: 'brave-otter-4f2a.relay.howispulse.com',
    baseDomain: 'relay.howispulse.com',
  });
  assert.match(toml, /serverAddr = "relay\.howispulse\.com"/);
  assert.match(toml, /serverPort = 7000/);
  assert.match(toml, /user = "brave-otter-4f2a\.relay\.howispulse\.com"/);
  assert.match(toml, /metadatas\.token = "plse_relay_x"/);
  assert.match(toml, /type = "http"/);
  assert.match(toml, /subdomain = "brave-otter-4f2a"/);   // erstes DNS-Label
  assert.match(toml, /localPort = 8002/);
});

test('tunnelComponent baut Spec und schreibt frpc.toml', () => {
  const root = join(tmpdir(), `frpc-test-${process.pid}`);
  mkdirSync(root, { recursive: true });
  try {
    const dirs = makeDataDirs(root);
    const spec = tunnelComponent({
      dirs,
      relay: { serverAddr: 'relay.howispulse.com:7000', authToken: 'SECRET',
               subdomain: 'brave-otter-4f2a.relay.howispulse.com' },
      chatPort: 8002,
    });
    assert.equal(spec.name, 'tunnel');
    assert.ok(spec.command.includes('frpc'), spec.command);
    assert.deepEqual(spec.args[0], '-c');
    const p = join(root, 'frpc.toml');
    assert.ok(existsSync(p));
    assert.match(readFileSync(p, 'utf8'), /subdomain = "brave-otter-4f2a"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
