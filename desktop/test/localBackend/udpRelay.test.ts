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

// — Scan 2026-10-08: Laufzeitfehler, Absenderprüfung, Peer-Grenze ————————

async function freierPort(): Promise<number> {
  const probe = createSocket('udp4');
  return new Promise<number>((r) => probe.bind(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => r(p));
  }));
}

test('udpRelay: Sendefehler nach dem Bind schließt den Listener NICHT', async () => {
  const listenPort = await freierPort();
  const logs: string[] = [];
  // Ziel Broadcast ohne SO_BROADCAST → jeder Weiterversand scheitert
  // asynchron (EACCES) — dieselbe Klasse wie ENETUNREACH nach WLAN-Wechsel.
  const relay = await startUdpRelayMapped([{ listen: listenPort, target: 9 }], '255.255.255.255', (m) => logs.push(m));
  const client = createSocket('udp4');
  try {
    client.send('x', listenPort, '127.0.0.1');
    client.send('y', listenPort, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(logs.some((l) => l.includes('Sendefehler')), `kein Sendefehler geloggt: ${logs.join(' | ')}`);
    assert.equal(logs.some((l) => l.includes('nicht bindbar')), false);
    // Lebt der Listener noch, ist der Port weiter belegt.
    const zweiter = createSocket('udp4');
    const belegt = await new Promise<boolean>((r) => {
      zweiter.once('error', () => r(true));
      zweiter.bind(listenPort, '0.0.0.0', () => r(false));
    });
    try { zweiter.close(); } catch { /* schon zu */ }
    assert.equal(belegt, true);
  } finally {
    client.close();
    relay.close();
  }
});

test('udpRelay: Antworten von fremdem Absender (nicht vmIp:target) werden verworfen', async () => {
  // Fake-VM empfängt auf `vm`, antwortet aber über einen ZWEITEN Socket —
  // Absenderport ≠ target, also kein Antwortpaket der VM.
  const vm = createSocket('udp4');
  const fremd = createSocket('udp4');
  await new Promise<void>((r) => vm.bind(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => fremd.bind(0, '127.0.0.1', () => r()));
  vm.on('message', (msg, peer) => fremd.send(msg, peer.port, peer.address));
  const listenPort = await freierPort();
  const relay = await startUdpRelayMapped([{ listen: listenPort, target: vm.address().port }], '127.0.0.1', () => {});
  const client = createSocket('udp4');
  try {
    const kam = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 300);
      client.once('message', () => { clearTimeout(t); resolve(true); });
      client.send('hallo', listenPort, '127.0.0.1');
    });
    assert.equal(kam, false);
  } finally {
    client.close();
    relay.close();
    vm.close();
    fremd.close();
  }
});

test('udpRelay: Peer-Obergrenze — der am längsten unbenutzte Peer weicht', async () => {
  const vm = await udpEcho();
  const listenPort = await freierPort();
  const relay = await startUdpRelayMapped(
    [{ listen: listenPort, target: vm.port }], '127.0.0.1', () => {}, { maxPeers: 1 },
  );
  const a = createSocket('udp4');
  const b = createSocket('udp4');
  try {
    assert.equal((await sendAndReceive(a, 'a1', listenPort)).data, 'ECHO:a1');
    assert.equal((await sendAndReceive(b, 'b1', listenPort)).data, 'ECHO:b1'); // verdrängt a
    // a bekommt eine neue Pipe und läuft weiter (verdrängt heißt nicht gesperrt).
    assert.equal((await sendAndReceive(a, 'a2', listenPort)).data, 'ECHO:a2');
  } finally {
    a.close();
    b.close();
    relay.close();
    vm.close();
  }
});

test('udpRelay: bindIps → Listener auf genau dieser Adresse', async () => {
  const vm = await udpEcho();
  const listenPort = await freierPort();
  const relay = await startUdpRelayMapped(
    [{ listen: listenPort, target: vm.port }], '127.0.0.1', () => {}, { bindIps: ['127.0.0.1'] },
  );
  const client = createSocket('udp4');
  try {
    assert.deepEqual(relay.boundPorts, [listenPort]);
    assert.equal((await sendAndReceive(client, 'q', listenPort)).data, 'ECHO:q');
  } finally {
    client.close();
    relay.close();
    vm.close();
  }
});
