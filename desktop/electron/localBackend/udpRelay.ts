/**
 * UDP-Relay Host → podman-machine-VM (Win/Mac).
 *
 * WSL/podman-machine "published ports" binden nur IN der VM; von Windows aus
 * wird ausschließlich TCP auf localhost weitergereicht — eingehendes UDP an
 * den Host (z.B. die ICE-Checks eines LAN-Browsers an den Direktpfad-Port
 * 7900) erreicht die VM NIE (auf dem Host lauscht schlicht niemand). Die
 * Server-App läuft auf dem Host und schließt die Lücke selbst: pro Port und
 * angekündigter Host-IP ein Listener, Datagramme gehen an die VM-IP auf
 * denselben Port.
 *
 * Warum je IP ein eigener Listener statt einer auf 0.0.0.0: ein Wildcard-
 * Socket antwortet mit der Quelladresse, die Windows nach der Routing-Tabelle
 * wählt — bei mehreren Adressen (LAN + WLAN, zweite IP auf demselben Adapter)
 * nicht zwingend die, an die der Peer geschickt hat. ICE verwirft eine Antwort
 * von der falschen Adresse. Ein auf die Kandidaten-Adresse gebundener Listener
 * antwortet immer von genau ihr. Ohne Liste (Tests, Altaufrufer) bleibt es
 * beim Wildcard-Bind.
 *
 * Rückweg (NAT-artig): Antworten der VM müssen zum richtigen Peer zurück und
 * dabei als Quelle den ANNOUNCED Port tragen (ICE prüft, dass die Antwort von
 * der Kandidaten-Adresse kommt). Deshalb pro Peer ein Wegwerf-Socket Richtung
 * VM (demultiplext die Antworten) und der Rückversand über den gebundenen
 * Listener (Quelle = :port). Idle-Peers werden nach IDLE_MS abgeräumt.
 *
 * Fail-soft: ein nicht bindbarer Port (z.B. weil WSL "mirrored networking"
 * ihn schon host-seitig bereitstellt) wird geloggt und übersprungen — die
 * übrigen Ports laufen weiter. Fehler NACH dem Bind (Sendefehler wie
 * ENETUNREACH nach WLAN-Wechsel/Resume) beenden den Listener nicht, sie werden
 * gedrosselt geloggt. Je Listener gelten die Grenzen aus relayGrenzen.ts.
 * Keine Electron-Imports (node:test-tauglich).
 */

import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import {
  MAX_PEERS, NeuePeerBremse, beruehre, gedrosselt, lruEinfuegen,
} from './relayGrenzen.ts';

/** Peer gilt nach dieser Stille als weg — ICE keepalives kommen alle ~2s,
 *  60s ist großzügig und hält die Map klein. */
const IDLE_MS = 60_000;
const SWEEP_MS = 30_000;

interface PeerPipe {
  toVm: Socket;
  lastSeen: number;
}

export interface UdpRelay {
  /** Ports, die auf mindestens einer Adresse gebunden wurden (Diagnose/Test). */
  boundPorts: number[];
  close(): void;
}

/** Listen-/Ziel-Port-Paar. Produktiv immer identisch (published Port = Mux-
 *  Port in der VM); getrennt nur für Tests (Relay + Fake-VM auf einer Maschine). */
export interface RelayPortPair {
  listen: number;
  target: number;
}

export interface UdpRelayOptionen {
  /** Host-Adressen, auf denen gelauscht wird (s. Dateikopf). Leer → 0.0.0.0. */
  bindIps?: string[];
  /** Peer-Obergrenze je Listener (Test-Seam; Vorgabe MAX_PEERS). */
  maxPeers?: number;
  /** Bremse für neue Peers (Test-Seam; Vorgabe je Relay eine eigene). */
  bremse?: NeuePeerBremse;
}

/** Startet die Relais für `ports` (Host bindIp:port ↔ vmIp:port). */
export function startUdpRelay(
  ports: number[],
  vmIp: string,
  log: (msg: string) => void = console.log,
  opts: UdpRelayOptionen = {},
): Promise<UdpRelay> {
  return startUdpRelayMapped(ports.map((p) => ({ listen: p, target: p })), vmIp, log, opts);
}

/** Wie startUdpRelay, aber mit expliziten Listen→Ziel-Paaren (Test-Seam). */
export function startUdpRelayMapped(
  ports: RelayPortPair[],
  vmIp: string,
  log: (msg: string) => void = console.log,
  opts: UdpRelayOptionen = {},
): Promise<UdpRelay> {
  const sockets: Socket[] = [];
  const sweeps: NodeJS.Timeout[] = [];
  const boundPorts = new Set<number>();
  const bindIps = opts.bindIps?.length ? opts.bindIps : ['0.0.0.0'];
  const maxPeers = opts.maxPeers ?? MAX_PEERS;
  const bremse = opts.bremse ?? new NeuePeerBremse();
  const meldeGedrosselt = gedrosselt(log);

  const bindOne = ({ listen: port, target }: RelayPortPair, bindIp: string): Promise<void> =>
    new Promise((resolve) => {
      const listener = createSocket('udp4');
      const peers = new Map<string, PeerPipe>();
      const wo = `${bindIp}:${port}`;
      const sendeFehler = (err: Error | null): void => {
        if (err) meldeGedrosselt(wo, `[udp-relay] ${wo}: Sendefehler (${(err as NodeJS.ErrnoException).code ?? err.message}) — läuft weiter`);
      };

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

      // Nur der BIND-Fehler überspringt den Port; der Handler wird beim
      // 'listening' gegen den Laufzeit-Handler getauscht. Vorher galt dieser
      // eine Handler für alles — ein einziger asynchroner Sendefehler schloss
      // den Listener, der Port war bis zum App-Neustart tot, und das Log
      // behauptete „nicht bindbar".
      const bindFehler = (e: Error): void => {
        log(`[udp-relay] ${wo} nicht bindbar (${(e as NodeJS.ErrnoException).code ?? e.message}) — übersprungen`);
        clearInterval(sweep);
        try { listener.close(); } catch { /* schon zu */ }
        resolve();
      };
      listener.once('error', bindFehler);

      listener.on('message', (msg, peer: RemoteInfo) => {
        const key = `${peer.address}:${peer.port}`;
        let pipe = peers.get(key);
        if (pipe) {
          beruehre(peers, key, pipe);
        } else {
          if (!bremse.erlaube(peer.address)) return; // Flut: still verwerfen
          const toVm = createSocket('udp4');
          toVm.on('error', () => { /* Peer-Pipe-Fehler → beim Sweep ersetzt */ });
          // Antworten der VM laufen über den LISTENER zurück — Quelle ist dann
          // der announced Port, genau was der ICE-Check des Peers erwartet.
          // Nur Pakete von genau vmIp:target zählen als Antwort: der
          // Wegwerf-Socket ist an einen Zufallsport auf allen Adressen
          // gebunden, und jeder, der ihn errät, käme sonst beim Peer an.
          toVm.on('message', (reply, von: RemoteInfo) => {
            if (von.address !== vmIp || von.port !== target) return;
            const p = peers.get(key);
            if (p) p.lastSeen = Date.now();
            listener.send(reply, peer.port, peer.address, sendeFehler);
          });
          pipe = { toVm, lastSeen: Date.now() };
          const alt = lruEinfuegen(peers, key, pipe, maxPeers);
          if (alt) { try { alt.toVm.close(); } catch { /* schon zu */ } }
        }
        pipe.lastSeen = Date.now();
        pipe.toVm.send(msg, target, vmIp, sendeFehler);
      });

      listener.bind(port, bindIp, () => {
        listener.off('error', bindFehler);
        listener.on('error', (e) => {
          meldeGedrosselt(wo, `[udp-relay] ${wo}: Laufzeitfehler (${(e as NodeJS.ErrnoException).code ?? e.message}) — läuft weiter`);
        });
        boundPorts.add(port);
        sockets.push(listener);
        listener.on('close', () => {
          for (const p of peers.values()) {
            try { p.toVm.close(); } catch { /* schon zu */ }
          }
          peers.clear();
        });
        resolve();
      });
    });

  const auftraege = ports.flatMap((p) => bindIps.map((ip) => bindOne(p, ip)));
  return Promise.all(auftraege).then(() => {
    const gebunden = ports.map((p) => p.listen).filter((p) => boundPorts.has(p));
    if (gebunden.length) {
      log(`[udp-relay] Host (${bindIps.join(', ')}) → VM (${vmIp}) aktiv für UDP ${gebunden.join(', ')}`);
    }
    return {
      boundPorts: gebunden,
      close(): void {
        for (const t of sweeps) clearInterval(t);
        for (const s of sockets) {
          try { s.close(); } catch { /* schon zu */ }
        }
      },
    };
  });
}
