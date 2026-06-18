import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeExternalAddressRequest, parseExternalAddressResponse,
  encodeMapRequest, parseMapResponse,
  encodePcpMapRequest, parsePcpMapResponse,
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

test('encodePcpMapRequest: 60 Byte, ver=2, op=1, Ports', () => {
  const b = encodePcpMapRequest({ clientIp: '192.168.1.50', proto: 'udp',
    internalPort: 7882, externalPort: 7882, lifetime: 3600, nonce: Buffer.alloc(12, 9) });
  assert.equal(b.length, 60);
  assert.equal(b.readUInt8(0), 2);            // version
  assert.equal(b.readUInt8(1), 1);            // opcode MAP (R=0)
  assert.equal(b.readUInt32BE(4), 3600);      // lifetime
  assert.equal(b.readUInt8(36), 17);          // protocol udp
  assert.equal(b.readUInt16BE(40), 7882);     // internal port
  assert.equal(b.readUInt16BE(42), 7882);     // suggested external port
});

test('parsePcpMapResponse: success + external port/ip', () => {
  const b = Buffer.alloc(60);
  b.writeUInt8(2, 0); b.writeUInt8(0x81, 1); b.writeUInt8(0, 3); // result 0
  b.writeUInt32BE(3600, 4);
  b.writeUInt8(17, 24);                        // protocol
  b.writeUInt16BE(7882, 28); b.writeUInt16BE(7882, 30);          // internal + external port
  // assigned external IP als IPv4-mapped ::ffff:203.0.113.7
  b.writeUInt16BE(0xffff, 32 + 10);
  b.writeUInt8(203, 44); b.writeUInt8(0, 45); b.writeUInt8(113, 46); b.writeUInt8(7, 47);
  const r = parsePcpMapResponse(b);
  assert.equal(r?.resultCode, 0);
  assert.equal(r?.externalPort, 7882);
  assert.equal(r?.externalIp, '203.0.113.7');
});
