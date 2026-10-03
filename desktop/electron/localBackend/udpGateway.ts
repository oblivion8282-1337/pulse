/**
 * UDP-Relay Host → Container über das TCP-Gateway (macOS/podman-machine).
 *
 * Auf mac-gvproxy erreicht eingehendes UDP den Container grundsätzlich nicht
 * (nachgewiesen 2026-10-03: published UDP kommt nie an, auch nicht nach
 * Outbound-Aktivität) — nur TCP wird zuverlässig published. Die Server-App
 * bindet deshalb die Medien-UDP-Ports selbst am Host und kapselt jeden
 * Client-Flow in eine TCP-Verbindung zum UDP-Gateway im Container
 * (infra/self-host s6-Service `udp-gateway`, Port 55981 — Host-seitig nur auf
 * 127.0.0.1 publiziert, der Weg ist also reiner Localhost-Loopback).
 *
 * Protokoll (s. Skriptkopf udp-gateway.py): Setup-Frame [2 Byte UDP-Port],
 * danach Frames [2 Byte Länge][Payload] beidseitig.
 *
 * Struktur wie udpRelay.ts (Listener pro Port + Wegwerf-Verbindungen pro Peer
 * + Idle-Sweep) — der Unterschied ist nur der Transport Host→Container:
 * dort UDP an die VM-IP (Win/WSL, VM vom Host erreichbar), hier TCP-Frames.
 * Keine Electron-Imports (node:test-tauglich).
 */

import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { connect as tcpConnect, type Socket as TcpSocket } from 'node:net';

/** Peer gilt nach dieser Stille als weg — ICE keepalives kommen alle ~2s,
 *  60s ist großzügig und hält die Map klein. */
const IDLE_MS = 60_000;
const SWEEP_MS = 30_000;

/** Connect-Frist für eine neue Gateway-Verbindung. */
const CONNECT_TIMEOUT_MS = 5_000;

interface PeerPipe {
  toGateway: TcpSocket;
  lastSeen: number;
}

export interface UdpGatewayRelay {
  /** Ports, die wirklich gebunden wurden (Diagnose/Test). */
  boundPorts: number[];
  close(): void;
}

function frame(payload: Buffer): Buffer {
  const head = Buffer.allocUnsafe(2);
  head.writeUInt16BE(payload.length);
  return Buffer.concat([head, payload]);
}

/** Listen-/Ziel-Port-Paar. Produktiv immer identisch (Host-Port = Container-
 *  Port); getrennt nur für Tests (Relay und Fake-UDP-Server auf einer Maschine
 *  können sich denselben Port nicht teilen — in Produktion trennt sie die
 *  Container-Grenze). */
export interface GatewayPortPair {
  listen: number;
  target: number;
}

/** Startet die Relais: Host 0.0.0.0:port ⇄ Gateway → 127.0.0.1:port. */
export function startUdpGatewayRelay(
  ports: number[],
  gatewayHost: string,
  gatewayPort: number,
  log: (msg: string) => void = console.log,
): Promise<UdpGatewayRelay> {
  return startUdpGatewayRelayMapped(
    ports.map((p) => ({ listen: p, target: p })),
    gatewayHost,
    gatewayPort,
    log,
  );
}

/** Wie startUdpGatewayRelay, mit expliziten Listen→Ziel-Paaren (Test-Seam). */
export function startUdpGatewayRelayMapped(
  ports: GatewayPortPair[],
  gatewayHost: string,
  gatewayPort: number,
  log: (msg: string) => void = console.log,
): Promise<UdpGatewayRelay> {
  const sockets: Socket[] = [];
  const sweeps: NodeJS.Timeout[] = [];
  const boundPorts: number[] = [];
  const allPipes = new Set<PeerPipe>();

  const bindOne = ({ listen, target }: GatewayPortPair): Promise<void> =>
    new Promise((resolve) => {
      const listener = createSocket('udp4');
      const peers = new Map<string, PeerPipe>();

      const sweep = setInterval(() => {
        const cutoff = Date.now() - IDLE_MS;
        for (const [key, pipe] of peers) {
          if (pipe.lastSeen < cutoff) {
            try { pipe.toGateway.destroy(); } catch { /* schon zu */ }
            peers.delete(key);
          }
        }
      }, SWEEP_MS);
      sweep.unref();
      sweeps.push(sweep);

      listener.on('error', (e) => {
        // EADDRINUSE etc. → Port überspringen, Rest läuft (fail-soft).
        log(`[udp-gateway-relay] Port ${port} nicht bindbar (${(e as NodeJS.ErrnoException).code ?? e.message}) — übersprungen`);
        try { listener.close(); } catch { /* schon zu */ }
        resolve();
      });

      listener.on('message', (msg: Buffer, peer: RemoteInfo) => {
        const key = `${peer.address}:${peer.port}`;
        const known = peers.get(key);
        if (known) {
          known.lastSeen = Date.now();
          try { known.toGateway.write(frame(msg)); } catch { peers.delete(key); }
          return;
        }

        // Neuer Peer: TCP-Verbindung zum Gateway; Setup-Frame + erstes Paket
        // gehen im connect-Callback raus (frühere Pakete puffert der Socket).
        const toGateway = tcpConnect({ host: gatewayHost, port: gatewayPort });
        toGateway.setTimeout(CONNECT_TIMEOUT_MS);
        let buf = Buffer.alloc(0);
        toGateway.on('connect', () => {
          const setup = Buffer.allocUnsafe(2);
          setup.writeUInt16BE(target);
          toGateway.write(setup);
          toGateway.write(frame(msg));
        });
        toGateway.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 2) {
            const len = buf.readUInt16BE(0);
            if (buf.length < 2 + len) break;
            const payload = buf.subarray(2, 2 + len);
            buf = buf.subarray(2 + len);
            const p = peers.get(key);
            if (p) p.lastSeen = Date.now();
            listener.send(payload, peer.port, peer.address);
          }
        });
        const pipe: PeerPipe = { toGateway, lastSeen: Date.now() };
        const verwerfen = () => {
          peers.delete(key);
          allPipes.delete(pipe);
        };
        toGateway.on('timeout', verwerfen);
        toGateway.on('error', verwerfen);
        toGateway.on('close', verwerfen);
        peers.set(key, pipe);
        allPipes.add(pipe);
      });

      listener.bind(listen, '0.0.0.0', () => {
        boundPorts.push(listen);
        sockets.push(listener);
        listener.on('close', () => {
          for (const pipe of peers.values()) {
            try { pipe.toGateway.destroy(); } catch { /* schon zu */ }
          }
          peers.clear();
        });
        resolve();
      });
    });

  return Promise.all(ports.map(bindOne)).then(() => {
    if (boundPorts.length) {
      log(`[udp-gateway-relay] Host→Gateway (${gatewayHost}:${gatewayPort}) aktiv für UDP ${boundPorts.join(', ')}`);
    }
    return {
      boundPorts,
      close(): void {
        for (const t of sweeps) clearInterval(t);
        for (const s of sockets) {
          try { s.close(); } catch { /* schon zu */ }
        }
        // Peer-TCP-Verbindungen mit zu — sonst halten sie den Prozess am Leben
        // und die Gateway-Gegenstellen bleiben hängen.
        for (const pipe of allPipes) {
          try { pipe.toGateway.destroy(); } catch { /* schon zu */ }
        }
      },
    };
  });
}

/** Ist das Container-Gateway erreichbar (TCP-Connect)? Für den Start-Pfad:
 *  neues Image → s6-Service; altes Image → App startet per exec nach. */
export function probeGateway(
  gatewayHost: string,
  gatewayPort: number,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = tcpConnect({ host: gatewayHost, port: gatewayPort });
    const fertig = (ok: boolean) => {
      conn.destroy();
      resolve(ok);
    };
    conn.setTimeout(timeoutMs);
    conn.on('connect', () => fertig(true));
    conn.on('timeout', () => fertig(false));
    conn.on('error', () => fertig(false));
  });
}
