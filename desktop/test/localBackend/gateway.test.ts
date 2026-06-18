import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGateway } from '../../electron/localBackend/gateway.ts';

test('parseGateway darwin (route -n get default)', () => {
  const out = `   route to: default\ndestination: default\n       gateway: 192.168.1.1\n   interface: en0\n`;
  assert.equal(parseGateway('darwin', out), '192.168.1.1');
});

test('parseGateway linux (ip route show default)', () => {
  assert.equal(parseGateway('linux', 'default via 10.0.0.1 dev eth0 proto dhcp metric 100\n'), '10.0.0.1');
});

test('parseGateway win32 (route print)', () => {
  const out = `Network Destination        Netmask          Gateway       Interface  Metric\n          0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.50     25\n`;
  assert.equal(parseGateway('win32', out), '192.168.0.1');
});

test('parseGateway: null wenn nichts passt', () => {
  assert.equal(parseGateway('linux', 'no default route here\n'), null);
});
