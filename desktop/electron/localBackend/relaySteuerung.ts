/**
 * Lebenszyklus der Windows-Host-Relays (udpRelay.ts + tcpRelay.ts) — aus
 * containerBackendManager.ts herausgezogen, damit er ohne VM testbar ist.
 *
 * Drei Fehler der Vorfassung (Scan 2026-10-08), die hier behoben sind:
 *  1. Die Relays merkten sich ihr Ziel nicht. Nach einem WSL-Neustart (neue
 *     172.x-VM-IP) blieb `ensureRelay()` ein No-op, und die Relays leiteten
 *     still an die alte Adresse. Jetzt: Ziel (VM-IP + Bind-Adressen) merken,
 *     bei Abweichung schließen und neu starten.
 *  2. Zwei überlappende Aufrufe (main.ts ruft `void ensureRelay()` bei jedem
 *     host:refresh) starteten beide Relays; der zweite band 0 Ports
 *     (EADDRINUSE) und überschrieb den ersten, der verwaist weiterlief.
 *     Jetzt: Single-Flight — ein laufender Abgleich wird geteilt.
 *  3. Ein Relay mit 0 gebundenen Ports galt als „läuft". Jetzt ist es keins
 *     (wird geschlossen, der nächste Abgleich versucht es erneut).
 *
 * Dazu: WSL-Mirrored-Modus (VM-IP ist eine Host-Adresse) → keine Relays,
 * einmal geloggt, sichtbar über `zustand().mirrored`.
 */

import type { UdpRelay } from './udpRelay.ts';
import type { TcpRelay } from './tcpRelay.ts';

/** Was der Abgleich braucht; `null`/`vmIp: null` = kein VM-Betrieb. */
export interface RelayZiel {
  vmIp: string | null;
  /** Host-Adressen, auf denen die UDP-Relays lauschen (s. udpRelay.ts). */
  bindIps: string[];
  /** VM-IP ist eine Host-Adresse (WSL mirrored, s. hostNetz.istMirrored). */
  mirrored: boolean;
}

export interface RelayStarter {
  udp(vmIp: string, bindIps: string[]): Promise<UdpRelay>;
  tcp(vmIp: string): Promise<TcpRelay>;
}

export interface RelayZustand {
  vmIp: string | null;
  bindIps: string[];
  mirrored: boolean;
  udpPorts: number[];
  tcpPorts: number[];
}

function schluessel(vmIp: string, bindIps: string[]): string {
  return `${vmIp}|${[...bindIps].sort().join(',')}`;
}

export class RelaySteuerung {
  private readonly starter: RelayStarter;
  private readonly log: (msg: string) => void;
  private udp: UdpRelay | null = null;
  private tcp: TcpRelay | null = null;
  private ziel: string | null = null;
  private letztes: RelayZiel | null = null;
  private laufend: Promise<void> | null = null;
  /** Wird bei jedem close() hochgezählt: ein Abgleich, der während eines
   *  Stopps noch startete, verwirft sein Ergebnis, statt es nach dem Stopp
   *  einzuhängen. */
  private generation = 0;

  constructor(starter: RelayStarter, log: (msg: string) => void = console.log) {
    this.starter = starter;
    this.log = log;
  }

  /** Relays auf `ermittle()` abgleichen. Läuft schon ein Abgleich, hängt sich
   *  der Aufruf an ihn an (auch die Ermittlung — sie kostet einen
   *  `podman machine ssh`). */
  abgleichen(ermittle: () => Promise<RelayZiel | null>): Promise<void> {
    if (this.laufend) return this.laufend;
    const lauf = this.fahre(ermittle).finally(() => {
      if (this.laufend === lauf) this.laufend = null;
    });
    this.laufend = lauf;
    return lauf;
  }

  private async fahre(ermittle: () => Promise<RelayZiel | null>): Promise<void> {
    const gen = this.generation;
    const z = await ermittle().catch(() => null);
    if (gen !== this.generation || !z?.vmIp) return; // gestoppt / kein VM-Betrieb
    if (z.mirrored) {
      if (!this.letztes?.mirrored) {
        this.log(`[relay] WSL mirrored erkannt (VM-IP ${z.vmIp} ist eine Host-Adresse) — keine Host-Relays nötig`);
      }
      this.schliesse();
      this.letztes = z;
      return;
    }
    this.letztes = z;
    const k = schluessel(z.vmIp, z.bindIps);
    if (this.ziel !== k) {
      if (this.ziel !== null) this.log(`[relay] Ziel geändert → Relays neu (${z.vmIp})`);
      this.schliesse();
      this.ziel = k;
    }
    const meineGen = this.generation;
    // `??=`-Logik: ein partieller Stand (nur ein Relay lief) zieht nur das
    // fehlende nach, statt ein laufendes zu ersetzen.
    if (!this.udp) {
      const r = await this.starter.udp(z.vmIp, z.bindIps).catch(() => null);
      this.udp = this.behalte(r, meineGen);
    }
    if (meineGen !== this.generation) return; // während des Starts gestoppt
    if (!this.tcp) {
      const r = await this.starter.tcp(z.vmIp).catch(() => null);
      this.tcp = this.behalte(r, meineGen);
    }
  }

  /** Relay mit 0 Ports ist keins; nach einem Stopp gestartete werden verworfen. */
  private behalte<R extends { boundPorts: number[]; close(): void }>(r: R | null, gen: number): R | null {
    if (!r) return null;
    if (gen !== this.generation || r.boundPorts.length === 0) {
      r.close();
      return null;
    }
    return r;
  }

  private schliesse(): void {
    this.generation += 1;
    this.udp?.close();
    this.udp = null;
    this.tcp?.close();
    this.tcp = null;
    this.ziel = null;
  }

  /** Alles schließen (stop()). Ein laufender Abgleich verwirft sein Ergebnis. */
  close(): void {
    this.schliesse();
    this.letztes = null;
  }

  /** Diagnose: wohin die Relays zeigen und welche Ports wirklich gebunden sind. */
  zustand(): RelayZustand {
    return {
      vmIp: this.letztes?.vmIp ?? null,
      bindIps: this.letztes?.bindIps ?? [],
      mirrored: this.letztes?.mirrored ?? false,
      udpPorts: this.udp?.boundPorts ?? [],
      tcpPorts: this.tcp?.boundPorts ?? [],
    };
  }
}
