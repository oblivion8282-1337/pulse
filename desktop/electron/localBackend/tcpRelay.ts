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
 * TLS-Eingriff). Die Bind-Adresse steht je Port in medienPorts.ts
 * (RELAY_TCP_PORTS): 1936 nur 127.0.0.1 (die Push-URL nutzt `localhost`),
 * LiveKits ICE-TCP 7881 auf 0.0.0.0 (fremde Geräte klopfen an die LAN-IP).
 *
 * close() reißt auch die LAUFENDEN Verbindungen ab — sonst hielte eine
 * RTMPS-Sitzung nach einem Relay-Neustart (neue VM-IP) die alte Strecke offen.
 * Der Aufbau zur VM hat eine Frist (CONNECT_TIMEOUT_MS). Keine Electron-Imports
 * (node:test-tauglich).
 */

import { createServer, connect, type Server, type Socket } from 'node:net';

/** Frist für den Verbindungsaufbau zur VM — danach wird der Client getrennt. */
const CONNECT_TIMEOUT_MS = 5_000;

export interface TcpRelay {
  /** Ports, die wirklich gebunden wurden (Diagnose/Test). */
  boundPorts: number[];
  close(): void;
}

/** Listen-/Ziel-Port-Paar. Produktiv immer identisch (Host:port → VM:port);
 *  getrennt nur für Tests (Relay + Fake-VM auf einer Maschine → sonst
 *  Port-Konflikt). `bind` fehlt → 127.0.0.1. */
export interface TcpPortPair {
  listen: number;
  target: number;
  bind?: string;
}

/** Startet TCP-Relais (Host bind:port → vmIp:port). Zahlen = 127.0.0.1. */
export function startTcpRelay(
  ports: ReadonlyArray<number | { port: number; bind: string }>,
  vmIp: string,
  log: (msg: string) => void = console.log,
): Promise<TcpRelay> {
  return startTcpRelayMapped(
    ports.map((p) => (typeof p === 'number'
      ? { listen: p, target: p }
      : { listen: p.port, target: p.port, bind: p.bind })),
    vmIp,
    log,
  );
}

/** Wie startTcpRelay, aber mit expliziten Listen→Ziel-Paaren (Test-Seam). */
export function startTcpRelayMapped(
  ports: TcpPortPair[],
  vmIp: string,
  log: (msg: string) => void = console.log,
): Promise<TcpRelay> {
  const servers: Server[] = [];
  const boundPorts: number[] = [];
  const offen = new Set<Socket>();

  const bindOne = ({ listen: port, target, bind = '127.0.0.1' }: TcpPortPair): Promise<void> =>
    new Promise((resolve) => {
      const server = createServer((client: Socket) => {
        const upstream = connect(target, vmIp);
        offen.add(client);
        offen.add(upstream);
        // Bidirektional durchpipen; ein Fehler/EOF auf einer Seite reißt beide
        // ab (destroy ist idempotent — doppelte Aufrufe sind harmlos).
        const teardown = (): void => { client.destroy(); upstream.destroy(); };
        upstream.setTimeout(CONNECT_TIMEOUT_MS);
        upstream.once('connect', () => upstream.setTimeout(0));
        upstream.on('timeout', teardown);
        client.on('error', teardown);
        upstream.on('error', teardown);
        client.on('close', () => { offen.delete(client); teardown(); });
        upstream.on('close', () => { offen.delete(upstream); teardown(); });
        client.pipe(upstream);
        upstream.pipe(client);
      });

      // Nur der Listen-Fehler überspringt den Port; danach eigener Handler.
      const listenFehler = (e: Error): void => {
        // Port belegt o.ä. → überspringen, Rest läuft (fail-soft).
        log(`[tcp-relay] ${bind}:${port} nicht bindbar (${(e as NodeJS.ErrnoException).code ?? e.message}) — übersprungen`);
        resolve();
      };
      server.once('error', listenFehler);

      server.listen(port, bind, () => {
        server.off('error', listenFehler);
        server.on('error', (e) => {
          log(`[tcp-relay] ${bind}:${port}: Laufzeitfehler (${(e as NodeJS.ErrnoException).code ?? e.message})`);
        });
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
        for (const s of offen) s.destroy();
        offen.clear();
      },
    };
  });
}
