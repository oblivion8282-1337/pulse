/**
 * TCP-Relay Host → podman-machine-VM (Win/Mac).
 *
 * Gegenstück zu udpRelay.ts für die TCP-Medienpfade. Nötig, weil der
 * allinone-Container mit `--network host` NICHT mehr per `-p` published wird
 * (das war die einzige Stelle, an der podman-machine `localhost:<port>` auf
 * dem Windows/Mac-Host in die VM leitete). Ohne Relay geht der RTMPS-Ingest
 * des OWNERS ins Leere: media-svc mintet dem Instanz-Owner bewusst eine
 * `rtmps://localhost:1936`-Push-URL (der Owner streamt „auf die eigene
 * Maschine") — auf Windows liegt MediaMTX aber in der VM, nicht auf
 * Host-localhost → FFmpeg scheitert mit `write_header`.
 *
 * Der Relay ist ein transparenter Byte-Durchreicher: die RTMPS-TLS-Sitzung
 * läuft Ende-zu-Ende zwischen Sidecar und MediaMTX DURCH den Relay (kein
 * TLS-Eingriff). Gebunden auf 127.0.0.1 (die Push-URL nutzt `localhost`), also
 * keine LAN-Exposition. Keine Electron-Imports (node:test-tauglich).
 */

import { createServer, connect, type Server, type Socket } from 'node:net';

export interface TcpRelay {
  /** Ports, die wirklich gebunden wurden (Diagnose/Test). */
  boundPorts: number[];
  close(): void;
}

/** Listen-/Ziel-Port-Paar. Produktiv immer identisch (Host:port → VM:port);
 *  getrennt nur für Tests (Relay + Fake-VM auf einer Maschine → sonst
 *  Port-Konflikt). */
export interface TcpPortPair {
  listen: number;
  target: number;
}

/** Startet TCP-Relais für `ports` (Host 127.0.0.1:port → vmIp:port). */
export function startTcpRelay(
  ports: number[],
  vmIp: string,
  log: (msg: string) => void = console.log,
): Promise<TcpRelay> {
  return startTcpRelayMapped(ports.map((p) => ({ listen: p, target: p })), vmIp, log);
}

/** Wie startTcpRelay, aber mit expliziten Listen→Ziel-Paaren (Test-Seam). */
export function startTcpRelayMapped(
  ports: TcpPortPair[],
  vmIp: string,
  log: (msg: string) => void = console.log,
): Promise<TcpRelay> {
  const servers: Server[] = [];
  const boundPorts: number[] = [];

  const bindOne = ({ listen: port, target }: TcpPortPair): Promise<void> =>
    new Promise((resolve) => {
      const server = createServer((client: Socket) => {
        const upstream = connect(target, vmIp);
        // Bidirektional durchpipen; ein Fehler/EOF auf einer Seite reißt beide
        // ab (destroy ist idempotent — doppelte Aufrufe sind harmlos).
        const teardown = (): void => { client.destroy(); upstream.destroy(); };
        client.on('error', teardown);
        upstream.on('error', teardown);
        client.pipe(upstream);
        upstream.pipe(client);
      });

      server.on('error', (e) => {
        // Port belegt o.ä. → überspringen, Rest läuft (fail-soft).
        log(`[tcp-relay] Port ${port} nicht bindbar (${(e as NodeJS.ErrnoException).code ?? e.message}) — übersprungen`);
        resolve();
      });

      // 127.0.0.1: die Owner-Push-URL zeigt auf `localhost` — kein LAN-Bind.
      server.listen(port, '127.0.0.1', () => {
        boundPorts.push(port);
        servers.push(server);
        resolve();
      });
    });

  return Promise.all(ports.map(bindOne)).then(() => {
    if (boundPorts.length) log(`[tcp-relay] Host→VM (${vmIp}) aktiv für TCP ${boundPorts.join(', ')}`);
    return {
      boundPorts,
      close(): void {
        for (const s of servers) {
          try { s.close(); } catch { /* schon zu */ }
        }
      },
    };
  });
}
