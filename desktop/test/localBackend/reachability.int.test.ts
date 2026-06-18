import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { checkReachability } from '../../electron/localBackend/reachability.ts';
import { PROBE_TCP_PORTS } from '../../electron/localBackend/reachability.ts';

test('checkReachability: Fake-Probe schickt UDP-Token → reachable', async () => {
  // Fake-Cloud-Probe: schickt das Token an 127.0.0.1:<udp_ports> + meldet tcp=true.
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      for (const p of body.udp_ports) {
        const s = createSocket('udp4');
        s.send(Buffer.from(body.token), p, '127.0.0.1', () => s.close());
      }
      const tcp: Record<string, boolean> = {};
      for (const p of body.tcp_ports) tcp[String(p)] = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ source_ip: body.public_ip, tcp }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const out = await checkReachability({
      probeUrl: `http://127.0.0.1:${port}/selfhost/reachability/probe`,
      discoverIp: async () => '203.0.113.5',   // STUN injiziert
      timeoutMs: 2000,
    });
    assert.equal(out.publicIp, '203.0.113.5');
    assert.equal(out.verdict, 'reachable');
    assert.ok(PROBE_TCP_PORTS.every((p) => out.probe?.tcp[p]));
  } finally { server.close(); }
});

test('checkReachability: STUN fehlgeschlagen → unknown', async () => {
  const out = await checkReachability({
    probeUrl: 'http://127.0.0.1:1/none', discoverIp: async () => null, timeoutMs: 500,
  });
  assert.equal(out.verdict, 'unknown');
});
