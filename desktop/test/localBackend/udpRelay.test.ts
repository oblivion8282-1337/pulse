import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { startUdpRelayMapped, startUdpRelay } from '../../electron/localBackend/udpRelay.ts';

/** Bindet einen UDP-Echo-Server auf einem ephemeren Port (die "Fake-VM"). */
function udpEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.on('message', (msg, peer) => s.send(Buffer.concat([Buffer.from('ECHO:'), msg]), peer.port, peer.address));
    s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }));
  });
}

function sendAndReceive(sock: Socket, payload: string, port: number): Promise<{ data: string; fromPort: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 3000);
    sock.once('message', (msg, from) => {
      clearTimeout(timer);
      resolve({ data: msg.toString(), fromPort: from.port });
    });
    sock.send(payload, port, '127.0.0.1');
  });
}

test('udpRelay: Roundtrip Peer → Relay → VM-Echo → Peer, Quelle = Listen-Port', async () => {
  const vm = await udpEcho();
  // Listen-Port ephemer wählen: erst binden lassen, dann Port ablesen — hier
  // einfach einen freien hohen Port über einen Wegwerf-Bind ermitteln.
  const probe = createSocket('udp4');
  const listenPort = await new Promise<number>((r) => probe.bind(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => r(p));
  }));
  const relay = await startUdpRelayMapped(
    [{ listen: listenPort, target: vm.port }],
    '127.0.0.1',
    () => {},
  );
  assert.deepEqual(relay.boundPorts, [listenPort]);

  const client = createSocket('udp4');
  try {
    const r1 = await sendAndReceive(client, 'hallo', listenPort);
    assert.equal(r1.data, 'ECHO:hallo');
    // ICE-kritisch: die Antwort MUSS vom announced Port kommen, nicht von
    // einem ephemeren Relay-Socket.
    assert.equal(r1.fromPort, listenPort);
    // Zweites Paket desselben Peers läuft über dieselbe Pipe.
    const r2 = await sendAndReceive(client, 'nochmal', listenPort);
    assert.equal(r2.data, 'ECHO:nochmal');
  } finally {
    client.close();
    relay.close();
    vm.close();
  }
});

test('udpRelay: zwei Peers werden getrennt demultiplext', async () => {
  const vm = await udpEcho();
  const probe = createSocket('udp4');
  const listenPort = await new Promise<number>((r) => probe.bind(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => r(p));
  }));
  const relay = await startUdpRelayMapped([{ listen: listenPort, target: vm.port }], '127.0.0.1', () => {});
  const a = createSocket('udp4');
  const b = createSocket('udp4');
  try {
    const [ra, rb] = await Promise.all([
      sendAndReceive(a, 'von-a', listenPort),
      sendAndReceive(b, 'von-b', listenPort),
    ]);
    assert.equal(ra.data, 'ECHO:von-a');
    assert.equal(rb.data, 'ECHO:von-b');
  } finally {
    a.close();
    b.close();
    relay.close();
    vm.close();
  }
});

test('udpRelay: belegter Port → fail-soft (übersprungen, kein throw)', async () => {
  // Port belegen …
  const blocker = createSocket('udp4');
  const port = await new Promise<number>((r) => blocker.bind(0, '0.0.0.0', () => r(blocker.address().port)));
  // … Relay auf demselben Port → bindet nicht, wirft aber auch nicht.
  const relay = await startUdpRelay([port], '127.0.0.1', () => {});
  try {
    assert.deepEqual(relay.boundPorts, []);
  } finally {
    relay.close();
    blocker.close();
  }
});
