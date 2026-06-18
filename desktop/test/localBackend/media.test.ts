import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLivekitConfig, renderMediamtxConfig } from '../../electron/localBackend/media.ts';

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
