import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeExternalAddressRequest, parseExternalAddressResponse,
  encodeMapRequest, parseMapResponse,
} from '../../electron/localBackend/natpmp.ts';

test('encodeExternalAddressRequest = [0,0]', () => {
  assert.ok(encodeExternalAddressRequest().equals(Buffer.from([0, 0])));
});

test('parseExternalAddressResponse: WAN-IP', () => {
  const b = Buffer.alloc(12);
  b.writeUInt8(0, 0); b.writeUInt8(128, 1); b.writeUInt16BE(0, 2);
  b.writeUInt32BE(123, 4); b.writeUInt8(203, 8); b.writeUInt8(0, 9); b.writeUInt8(113, 10); b.writeUInt8(7, 11);
  assert.deepEqual(parseExternalAddressResponse(b), { resultCode: 0, externalIp: '203.0.113.7' });
});

test('encodeMapRequest udp: 12 Byte, op=1, Ports, Lifetime', () => {
  const b = encodeMapRequest('udp', 7882, 7882, 3600);
  assert.equal(b.length, 12);
  assert.equal(b.readUInt8(0), 0);
  assert.equal(b.readUInt8(1), 1);            // udp
  assert.equal(b.readUInt16BE(4), 7882);      // internal
  assert.equal(b.readUInt16BE(6), 7882);      // external
  assert.equal(b.readUInt32BE(8), 3600);      // lifetime
});

test('encodeMapRequest tcp: op=2', () => {
  assert.equal(encodeMapRequest('tcp', 1936, 1936, 3600).readUInt8(1), 2);
});

test('parseMapResponse: result+ports+lifetime', () => {
  const b = Buffer.alloc(16);
  b.writeUInt8(0, 0); b.writeUInt8(129, 1); b.writeUInt16BE(0, 2); b.writeUInt32BE(9, 4);
  b.writeUInt16BE(7882, 8); b.writeUInt16BE(7882, 10); b.writeUInt32BE(3600, 12);
  assert.deepEqual(parseMapResponse(b),
    { resultCode: 0, internalPort: 7882, externalPort: 7882, lifetime: 3600 });
});
