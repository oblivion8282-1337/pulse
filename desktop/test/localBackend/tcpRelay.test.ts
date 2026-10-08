import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Server } from 'node:net';
import { startTcpRelay, startTcpRelayMapped } from '../../electron/localBackend/tcpRelay.ts';

/** TCP-Echo-Server auf ephemerem Port (die "Fake-VM"). */
function tcpEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s: Server = createServer((sock) => { sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('R:'), d]))); });
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
  });
}

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); });
  });
}

test('tcpRelay: transparenter Roundtrip Client → Relay → VM-Echo', async () => {
  const vm = await tcpEcho();
  const listen = await freePort();
  // Fake-VM (Echo) auf vm.port, Relay lauscht auf listen → forwardet auf vm.port
  // (getrennte Ports, weil Host==VM==127.0.0.1 im Test).
  const relay = await startTcpRelayMapped([{ listen, target: vm.port }], '127.0.0.1', () => {});
  assert.deepEqual(relay.boundPorts, [listen]);

  const got = await new Promise<string>((resolve, reject) => {
    const c = connect(listen, '127.0.0.1', () => c.write('hallo'));
    c.on('data', (d) => { resolve(d.toString()); c.end(); });
    c.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
  assert.equal(got, 'R:hallo');
  relay.close();
  vm.close();
});

test('tcpRelay: belegter Port → fail-soft (übersprungen, kein throw)', async () => {
  const blocker = createServer();
  const port = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as { port: number }).port)));
  const relay = await startTcpRelay([port], '127.0.0.1', () => {});
  assert.deepEqual(relay.boundPorts, []);
  relay.close();
  blocker.close();
});

test('tcpRelay: close() reißt auch laufende Verbindungen ab', async () => {
  const vm = await tcpEcho();
  const listen = await freePort();
  const relay = await startTcpRelayMapped([{ listen, target: vm.port }], '127.0.0.1', () => {});
  const c = connect(listen, '127.0.0.1');
  await new Promise<void>((r) => c.on('connect', () => r()));
  c.write('x');
  await new Promise<void>((r) => c.once('data', () => r()));
  const zu = new Promise<boolean>((r) => {
    const t = setTimeout(() => r(false), 2000);
    c.on('close', () => { clearTimeout(t); r(true); });
  });
  c.on('error', () => {});
  relay.close();
  assert.equal(await zu, true);
  vm.close();
});

test('tcpRelay: Bind-Adresse je Port ({ port, bind })', async () => {
  const vm = await tcpEcho();
  const listen = await freePort();
  const relay = await startTcpRelayMapped([{ listen, target: vm.port, bind: '127.0.0.1' }], '127.0.0.1', () => {});
  assert.deepEqual(relay.boundPorts, [listen]);
  relay.close();
  vm.close();
});
