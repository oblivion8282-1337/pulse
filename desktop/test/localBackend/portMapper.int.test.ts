import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mapMediaPorts } from '../../electron/localBackend/portMapper.ts';

// Fake-NAT-PMP-Server: external-address → 203.0.113.7; map → success, external==internal.
function fakeServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.on('message', (msg, rinfo) => {
      if (msg.length === 2 && msg.readUInt8(1) === 0) {
        const r = Buffer.alloc(12);
        r.writeUInt8(0, 0); r.writeUInt8(128, 1); r.writeUInt16BE(0, 2); r.writeUInt32BE(1, 4);
        r.writeUInt8(203, 8); r.writeUInt8(0, 9); r.writeUInt8(113, 10); r.writeUInt8(7, 11);
        s.send(r, rinfo.port, rinfo.address);
      } else if (msg.length === 12) {
        const op = msg.readUInt8(1);
        const intern = msg.readUInt16BE(4);
        const r = Buffer.alloc(16);
        r.writeUInt8(0, 0); r.writeUInt8(128 + op, 1); r.writeUInt16BE(0, 2); r.writeUInt32BE(1, 4);
        r.writeUInt16BE(intern, 8); r.writeUInt16BE(intern, 10); r.writeUInt32BE(3600, 12);
        s.send(r, rinfo.port, rinfo.address);
      }
    });
    s.bind(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
  });
}

test('mapMediaPorts: Fake-NAT-PMP → mapped', async () => {
  const srv = await fakeServer();
  try {
    const out = await mapMediaPorts({
      stunIp: '203.0.113.7', gateway: '127.0.0.1', natpmpPort: srv.port, timeoutMs: 1500,
    });
    assert.equal(out.wanIp, '203.0.113.7');
    assert.equal(out.verdict, 'mapped');
    assert.equal(out.failedPorts.length, 0);
  } finally { srv.close(); }
});

test('mapMediaPorts: kein Server → unsupported', async () => {
  const out = await mapMediaPorts({
    stunIp: '203.0.113.7', gateway: '127.0.0.1', natpmpPort: 1, timeoutMs: 400,
  });
  assert.equal(out.verdict, 'unsupported');
});

test('mapMediaPorts: WAN-IP ≠ STUN-IP → cgnat', async () => {
  const srv = await fakeServer();  // meldet 203.0.113.7
  try {
    const out = await mapMediaPorts({
      stunIp: '8.8.8.8', gateway: '127.0.0.1', natpmpPort: srv.port, timeoutMs: 1500,
    });
    assert.equal(out.verdict, 'cgnat');
  } finally { srv.close(); }
});
