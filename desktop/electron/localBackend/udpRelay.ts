/**
 * UDP-Relay Host → podman-machine-VM (Win/Mac).
 *
 * WSL/podman-machine "published ports" binden nur IN der VM; von Windows aus
 * wird ausschließlich TCP auf localhost weitergereicht — eingehendes UDP an
 * den Host (z.B. die ICE-Checks eines LAN-Browsers an den Direktpfad-Port
 * 7900) erreicht die VM NIE (auf dem Host lauscht schlicht niemand). Die
 * Server-App läuft auf dem Host und schließt die Lücke selbst: pro Port ein
 * Listener auf 0.0.0.0, Datagramme gehen an die VM-IP auf denselben Port.
 *
 * Rückweg (NAT-artig): Antworten der VM müssen zum richtigen Peer zurück und
 * dabei als Quelle den ANNOUNCED Port tragen (ICE prüft, dass die Antwort von
 * der Kandidaten-Adresse kommt). Deshalb pro Peer ein Wegwerf-Socket Richtung
 * VM (demultiplext die Antworten) und der Rückversand über den gebundenen
 * Listener (Quelle = :port). Idle-Peers werden nach IDLE_MS abgeräumt.
 *
 * Fail-soft: ein nicht bindbarer Port (z.B. weil WSL "mirrored networking"
 * ihn schon host-seitig bereitstellt) wird geloggt und übersprungen — die
 * übrigen Ports laufen weiter. Keine Electron-Imports (node:test-tauglich).
 */

import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';

/** Peer gilt nach dieser Stille als weg — ICE keepalives kommen alle ~2s,
 *  60s ist großzügig und hält die Map klein. */
const IDLE_MS = 60_000;
const SWEEP_MS = 30_000;

interface PeerPipe {
  toVm: Socket;
  lastSeen: number;
}

export interface UdpRelay {
  /** Ports, die wirklich gebunden wurden (Diagnose/Test). */
  boundPorts: number[];
  close(): void;
}

/** Listen-/Ziel-Port-Paar. Produktiv immer identisch (published Port = Mux-
 *  Port in der VM); getrennt nur für Tests (Relay + Fake-VM auf einer Maschine). */
export interface RelayPortPair {
  listen: number;
  target: number;
}

/** Startet die Relais für `ports` (Host 0.0.0.0:port ↔ vmIp:port). */
export function startUdpRelay(
  ports: number[],
  vmIp: string,
  log: (msg: string) => void = console.log,
): Promise<UdpRelay> {
  return startUdpRelayMapped(ports.map((p) => ({ listen: p, target: p })), vmIp, log);
}

/** Wie startUdpRelay, aber mit expliziten Listen→Ziel-Paaren (Test-Seam). */
export function startUdpRelayMapped(
  ports: RelayPortPair[],
  vmIp: string,
  log: (msg: string) => void = console.log,
): Promise<UdpRelay> {
  const sockets: Socket[] = [];
  const sweeps: NodeJS.Timeout[] = [];
  const boundPorts: number[] = [];

  const bindOne = ({ listen: port, target }: RelayPortPair): Promise<void> =>
    new Promise((resolve) => {
      const listener = createSocket('udp4');
      const peers = new Map<string, PeerPipe>();

      const sweep = setInterval(() => {
        const cutoff = Date.now() - IDLE_MS;
        for (const [key, pipe] of peers) {
          if (pipe.lastSeen < cutoff) {
            try { pipe.toVm.close(); } catch { /* schon zu */ }
            peers.delete(key);
          }
        }
      }, SWEEP_MS);
      sweep.unref();
      sweeps.push(sweep);

      listener.on('error', (e) => {
        // EADDRINUSE etc. → Port überspringen, Rest läuft (fail-soft).
        log(`[udp-relay] Port ${port} nicht bindbar (${(e as NodeJS.ErrnoException).code ?? e.message}) — übersprungen`);
        try { listener.close(); } catch { /* schon zu */ }
        resolve();
      });

      listener.on('message', (msg, peer: RemoteInfo) => {
        const key = `${peer.address}:${peer.port}`;
        let pipe = peers.get(key);
        if (!pipe) {
          const toVm = createSocket('udp4');
          toVm.on('error', () => { /* Peer-Pipe-Fehler → beim Sweep ersetzt */ });
          // Antworten der VM laufen über den LISTENER zurück — Quelle ist dann
          // der announced Port, genau was der ICE-Check des Peers erwartet.
          toVm.on('message', (reply) => {
            const p = peers.get(key);
            if (p) p.lastSeen = Date.now();
            listener.send(reply, peer.port, peer.address);
          });
          pipe = { toVm, lastSeen: Date.now() };
          peers.set(key, pipe);
        }
        pipe.lastSeen = Date.now();
        pipe.toVm.send(msg, target, vmIp);
      });

      listener.bind(port, '0.0.0.0', () => {
        boundPorts.push(port);
        sockets.push(listener);
        listener.on('close', () => {
          for (const pipe of peers.values()) {
            try { pipe.toVm.close(); } catch { /* schon zu */ }
          }
          peers.clear();
        });
        resolve();
      });
    });

  return Promise.all(ports.map(bindOne)).then(() => {
    if (boundPorts.length) log(`[udp-relay] Host→VM (${vmIp}) aktiv für UDP ${boundPorts.join(', ')}`);
    return {
      boundPorts,
      close(): void {
        for (const t of sweeps) clearInterval(t);
        for (const s of sockets) {
          try { s.close(); } catch { /* schon zu */ }
        }
      },
    };
  });
}
