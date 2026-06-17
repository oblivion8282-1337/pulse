// desktop/test/localBackend/tunnel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRatholeClientConfig } from '../../electron/localBackend/tunnel.ts';

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
