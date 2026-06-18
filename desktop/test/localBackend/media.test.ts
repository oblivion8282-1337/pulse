import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderLivekitConfig, renderMediamtxConfig, mediaComponents } from '../../electron/localBackend/media.ts';
import { makeDataDirs, FIXTURE_SECRETS } from './fixtures.ts';

test('renderLivekitConfig: NAT-aware + eingebauter TURN', () => {
  const y = renderLivekitConfig({ apiKey: 'pulse-selfhost', apiSecret: 'deadbeef',
    voicePort: 8003, domain: 'brave-otter-4f2a.relay.howispulse.com' });
  assert.match(y, /port: 7880/);
  assert.match(y, /- 0\.0\.0\.0/);              // bind_addresses
  assert.match(y, /use_external_ip: true/);
  assert.match(y, /tcp_port: 7881/);
  assert.match(y, /port_range_start: 7882/);
  assert.match(y, /port_range_end: 7892/);
  assert.match(y, /enabled: true/);             // turn
  assert.match(y, /udp_port: 3478/);
  assert.match(y, /pulse-selfhost: deadbeef/);  // keys
  assert.match(y, /http:\/\/127\.0\.0\.1:8003\/webhook/);
});

test('renderMediamtxConfig: additionalHosts + auth-hook + STUN', () => {
  const y = renderMediamtxConfig({ certPath: '/s/mediamtx.crt', keyPath: '/s/mediamtx.key',
    authHookPort: 55546, additionalHost: 'brave-otter-4f2a.relay.howispulse.com',
    stunUrl: 'stun:stun.l.google.com:19302' });
  assert.match(y, /webrtcAddress: :8889/);
  assert.match(y, /webrtcLocalUDPAddress: :8189/);
  assert.match(y, /webrtcAdditionalHosts: \[brave-otter-4f2a\.relay\.howispulse\.com\]/);
  assert.match(y, /stun:stun\.l\.google\.com:19302/);
  assert.match(y, /rtmpsAddress: :1936/);
  assert.match(y, /rtmpServerCert: \/s\/mediamtx\.crt/);
  assert.match(y, /authHTTPAddress: http:\/\/127\.0\.0\.1:55546/);
});

test('mediaComponents: schreibt Configs + baut 2 Specs', () => {
  const root = join(tmpdir(), `media-components-test-${process.pid}`);
  mkdirSync(root, { recursive: true });
  try {
    const dirs = makeDataDirs(root);
    mkdirSync(dirs.secrets, { recursive: true });
    const specs = mediaComponents({
      dirs,
      secrets: FIXTURE_SECRETS,
      env: {},
      voicePort: 55547,
      authHookPort: 55546,
      domain: 'brave-otter-4f2a.relay.howispulse.com',
    });
    assert.equal(specs.length, 2);

    const livekit = specs[0];
    assert.equal(livekit.name, 'livekit');
    assert.ok(livekit.command.includes('livekit-server'), `command: ${livekit.command}`);
    assert.equal(livekit.args[0], '--config');
    assert.ok(existsSync(livekit.args[1]), `livekit.yaml missing: ${livekit.args[1]}`);

    const mediamtx = specs[1];
    assert.equal(mediamtx.name, 'mediamtx');
    assert.ok(mediamtx.command.includes('mediamtx'), `command: ${mediamtx.command}`);
    assert.ok(existsSync(mediamtx.args[0]), `mediamtx.yml missing: ${mediamtx.args[0]}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
