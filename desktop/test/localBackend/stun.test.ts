import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStunRequest, parseStunResponse, STUN_MAGIC_COOKIE } from '../../electron/localBackend/stun.ts';

test('buildStunRequest: 20-Byte Binding-Request mit Magic-Cookie', () => {
  const { packet, transactionId } = buildStunRequest();
  assert.equal(packet.length, 20);
  assert.equal(packet.readUInt16BE(0), 0x0001);   // Binding Request
  assert.equal(packet.readUInt16BE(2), 0x0000);   // Length 0
  assert.equal(packet.readUInt32BE(4), STUN_MAGIC_COOKIE);
  assert.equal(transactionId.length, 12);
  assert.ok(packet.subarray(8, 20).equals(transactionId));
});

// Baut eine STUN-Success-Response mit XOR-MAPPED-ADDRESS für ip:port (ohne hand-berechnete Bytes).
function synthResponse(ip: string, port: number): Buffer {
  const txid = Buffer.alloc(12, 7);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0);                 // Success Response
  header.writeUInt16BE(12, 2);                     // Attr-Länge: 4 (attr-hdr) + 8 (value)
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txid.copy(header, 8);
  const attr = Buffer.alloc(12);
  attr.writeUInt16BE(0x0020, 0);                   // XOR-MAPPED-ADDRESS
  attr.writeUInt16BE(8, 2);                        // value length
  attr.writeUInt8(0x00, 4);                        // reserved
  attr.writeUInt8(0x01, 5);                        // family IPv4
  attr.writeUInt16BE(port ^ (STUN_MAGIC_COOKIE >>> 16), 6);  // X-Port
  const oct = ip.split('.').map(Number);
  const cookie = Buffer.alloc(4); cookie.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
  for (let i = 0; i < 4; i++) attr.writeUInt8(oct[i] ^ cookie[i], 8 + i);  // X-Address
  return Buffer.concat([header, attr]);
}

test('parseStunResponse: gewinnt IPv4 aus XOR-MAPPED-ADDRESS zurück', () => {
  assert.equal(parseStunResponse(synthResponse('203.0.113.5', 54321)), '203.0.113.5');
});

test('parseStunResponse: null ohne XOR-MAPPED-ADDRESS', () => {
  const { packet } = buildStunRequest();
  assert.equal(parseStunResponse(packet), null);
});
