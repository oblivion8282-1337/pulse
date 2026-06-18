import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderFrpcConfig, tunnelComponent } from '../../electron/localBackend/tunnel.ts';
import { makeDataDirs } from './fixtures.ts';

const PORTS = { auth: 55543, chat: 55544, voice: 55547, livekit: 7880, whep: 8889, hls: 8888 };

test('renderFrpcConfig: Multi-Proxy mit locations', () => {
  const toml = renderFrpcConfig({
    relayServerAddr: 'relay.howispulse.com:7000', authToken: 'TKN',
    fullSubdomain: 'brave-otter-4f2a.relay.howispulse.com', baseDomain: 'relay.howispulse.com',
    ports: PORTS,
  });
  assert.match(toml, /serverAddr = "relay\.howispulse\.com"/);
  assert.match(toml, /subdomain = "brave-otter-4f2a"/);
  // je ein Proxy pro Pfadgruppe
  assert.match(toml, /locations = \["\/api\/auth"\]/);
  assert.match(toml, /locations = \["\/api\/chat", "\/api\/ws"\]/);
  assert.match(toml, /locations = \["\/api\/voice"\]/);
  assert.match(toml, /locations = \["\/livekit"\]/);
  assert.match(toml, /locations = \["\/whep"\]/);
  assert.match(toml, /locations = \["\/hls"\]/);
  assert.match(toml, /locations = \["\/"\]/);
  // localPorts korrekt
  assert.match(toml, /localPort = 7880/);   // livekit
  assert.match(toml, /localPort = 8889/);   // whep
  assert.match(toml, /localPort = 55547/);  // voice
  // 7 Proxy-Blöcke
  assert.equal((toml.match(/\[\[proxies\]\]/g) ?? []).length, 7);
});

test('tunnelComponent: schreibt frpc.toml, command frpc', () => {
  const root = join(tmpdir(), `frpc3-${process.pid}`);
  mkdirSync(root, { recursive: true });
  try {
    const spec = tunnelComponent({
      dirs: makeDataDirs(root),
      relay: { serverAddr: 'relay.howispulse.com:7000', authToken: 'S',
               subdomain: 'brave-otter-4f2a.relay.howispulse.com' },
      ports: PORTS,
    });
    assert.equal(spec.name, 'tunnel');
    assert.ok(spec.command.includes('frpc'));
    assert.match(readFileSync(join(root, 'frpc.toml'), 'utf8'), /locations = \["\/livekit"\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
