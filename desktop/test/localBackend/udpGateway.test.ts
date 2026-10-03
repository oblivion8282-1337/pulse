/**
 * udpGateway — Host-Relay ⇄ TCP-Gateway ⇄ UDP-Server (Ende-zu-Ende im Test).
 *
 * Das Fake-Gateway verhält sich wie der s6-Service `udp-gateway` (Setup-Frame
 * + [2B len][payload]-Frames, UDP-Zustellung an 127.0.0.1:<port>) und das
 * Fake-„LiveKit" echoed jedes UDP-Paket. Geprüft wird der komplette Weg:
 * Client → Host-Relay (UDP) → TCP-Frames → Gateway → UDP → Echo → zurück,
 * inklusive Quelle (Antwort muss vom Relais-Listener kommen = Kandidaten-
 * Adresse) und probeGateway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket as NetSocket } from 'node:net';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import { startUdpGatewayRelayMapped, probeGateway } from '../../electron/localBackend/udpGateway.ts';

/** Freien UDP-Port finden (bind + sofort wieder lösen). */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function recvn(sock: NetSocket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf: Buffer[] = [];
    let len = 0;
    const onData = (c: Buffer) => {
      buf.push(c);
      len += c.length;
      if (len >= n) {
        sock.off('data', onData);
        sock.off('error', onError);
        resolve(Buffer.concat(buf).subarray(0, n));
      }
    };
    const onError = (e: Error) => reject(e);
    sock.on('data', onData);
    sock.on('error', onError);
  });
}

test('probeGateway: offener Port → true, geschlossener → false', async () => {
  const gw = createServer();
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  const port = (gw.address() as { port: number }).port;
  assert.equal(await probeGateway('127.0.0.1', port), true);
  gw.close();
  assert.equal(await probeGateway('127.0.0.1', 1), false); // Port 1: nichts lauscht
});

test('Ende-zu-Ende: UDP → Relay → TCP-Frames → Gateway → UDP-Echo → zurück', async () => {
  // Fake-„LiveKit": UDP-Echo auf zufälligem Port.
  const echo = createSocket('udp4');
  await new Promise<void>((r) => echo.bind(0, '127.0.0.1', r));
  const echoPort = (echo.address() as { port: number }).port;
  echo.on('message', (msg, addr) => echo.send(Buffer.concat([Buffer.from('echo:'), msg]), addr.port, addr.address));

  // Fake-Gateway (Protokoll wie udp-gateway.py): Setup-Frame → UDP-Ziel.
  // TCP kommt als Strom — Setup und erster Frame können im selben Segment
  // ankommen, also puffer-drain statt einzelnes recvn.
  const gw = createServer((conn: NetSocket) => {
    let buf = Buffer.alloc(0);
    let udp: DgramSocket | null = null;
    let udpPort = 0;
    const drain = () => {
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const payload = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        udp!.send(payload, udpPort, '127.0.0.1');
      }
    };
    conn.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (!udp) {
        if (buf.length < 2) return;
        udpPort = buf.readUInt16BE(0);
        buf = buf.subarray(2);
        udp = createSocket('udp4');
        udp.on('message', (data) => {
          const head = Buffer.allocUnsafe(2);
          head.writeUInt16BE(data.length);
          conn.write(Buffer.concat([head, data]));
        });
        udp.bind(0, '127.0.0.1', () => drain());
      }
      drain();
    });
    conn.on('close', () => udp?.close()); // Event-Loop für node --test freigeben
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  const gwPort = (gw.address() as { port: number }).port;

  // Getrennte Listen/Ziel-Ports (Test-Seam): Relay und Echo-UDP teilen sich
  // im Test eine Maschine — in Produktion trennt sie die Container-Grenze.
  const listenPort = await freeUdpPort();
  const relay = await startUdpGatewayRelayMapped(
    [{ listen: listenPort, target: echoPort }], '127.0.0.1', gwPort, () => {},
  );
  assert.deepEqual(relay.boundPorts, [listenPort]);

  // Client sendet ans Relay und erwartet das Echo vom Relay-Listener zurück.
  const client = createSocket('udp4');
  client.bind(0, '127.0.0.1');
  const antwort = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kein Echo durchs Relay')), 5000);
    client.once('message', (msg, rinfo) => {
      clearTimeout(timer);
      assert.equal(rinfo.port, listenPort); // Quelle = Kandidaten-Port
      resolve(msg);
    });
    client.send(Buffer.from('hallo'), listenPort, '127.0.0.1');
  });
  assert.equal(antwort.toString(), 'echo:hallo');

  client.close();
  relay.close();
  echo.close();
  gw.close();
});
