/**
 * Container-Backend-Manager: startet den kompletten Pulse-Server als EINEN
 * allinone-Container (ersetzt die frühere native Prozess-Orchestrierung —
 * das Image initialisiert Postgres/Secrets/Migrationen selbst, frpc für den
 * Relay-Tunnel läuft seit Phase 0.1 im Image).
 *
 * Ablauf von start():
 *   Runtime finden → Env-Datei rendern (nur die PULSE_*-Pairing-Werte) →
 *   Registry-Login (Instanz-Creds) → pull → alten Container ersetzen → run →
 *   Health-Poll. stop() stoppt den Container; das /data-Volume bleibt.
 *
 * Secrets (client_secret, Tunnel-Token) landen NUR in der 0600-Env-Datei und
 * im --password-stdin-Login — nie in argv, nie in Logs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BootstrapCreds } from './pairing.ts';
import { detectRuntime, ensureMachine, rtExec, type ContainerRuntime } from './containerRuntime.ts';
import { waitFor, httpHealth } from './health.ts';

export const CONTAINER_NAME = 'pulse-host';
export const DATA_VOLUME = 'pulse-host-data';
export const DEFAULT_IMAGE = 'registry.howispulse.com/pulse-allinone:edge';

/** Dev/Test-Seam: `PULSE_HOST_IMAGE` zeigt auf ein lokal gebautes Image —
 *  dann entfallen Registry-Login + Pull (Dev-Instanz-Creds existieren im
 *  Prod-Registry-Realm nicht). Prod-Pfad bleibt der Default. */
export function resolveImage(env: Record<string, string | undefined> = process.env): {
  image: string;
  local: boolean;
} {
  const override = env.PULSE_HOST_IMAGE;
  return override ? { image: override, local: true } : { image: DEFAULT_IMAGE, local: false };
}

/** Host-Port für den behind-proxy-HTTP des Containers (nur 127.0.0.1 —
 *  öffentlicher Zugang läuft über den Relay-Tunnel im Container). Bewusst
 *  hoch/ephemer, analog zu den alten nativen Default-Ports. */
export const HOST_HTTP_PORT = 55580;

/** Medien-Ports (Voice/Streams gehen direkt zum Gerät, nicht über den Relay).
 *  MUSS mit portMapper.ts (NAT-PMP-Mapping am Router) synchron bleiben. */
const MEDIA_PORT_ARGS = [
  '-p', '3478:3478/tcp',
  '-p', '3478:3478/udp',
  '-p', '7882-7892:7882-7892/udp',
  '-p', '1936:1936/tcp',
  '-p', '8189:8189/udp',
  // Direktpfad-Adapter (WebRTC-DataChannel für Chat ohne Cloud im Datenweg,
  // Plan 2026-07-09-direct-path-webrtc): STUN-Discovery + ICE laufen über
  // genau diesen Port.
  '-p', '7900:7900/udp',
];

/** Rendert die kleine Container-Env: nur Pairing-Identität + Relay + TLS-Modus.
 *  Alles Weitere (DB, Secrets, Keys) erzeugt das Image selbst in /data. */
export function renderContainerEnv(creds: BootstrapCreds, adminEmail?: string): string {
  const hostname = creds.relaySubdomain ?? creds.hostname;
  const lines = [
    `PULSE_HOSTNAME=${hostname}`,
    `PULSE_INSTANCE_ID=${creds.instanceId}`,
    `PULSE_INSTANCE_OWNER_ID=${creds.ownerId}`,
    `PULSE_CLOUD_CLIENT_ID=${creds.clientId}`,
    `PULSE_CLOUD_CLIENT_SECRET=${creds.clientSecret}`,
    `PULSE_CLOUD_ORIGIN=${creds.cloudOrigin}`,
    // 10-check will eine nicht-leere Admin-Mail; für App-Hosts ist sie rein
    // informativ (kein SMTP-Versand nötig) → Platzhalter, wenn keine bekannt.
    `PULSE_ADMIN_EMAIL=${adminEmail ?? `admin@${hostname}`}`,
    // Der Relay terminiert TLS — der Container routet nur HTTP intern.
    'PULSE_TLS_MODE=behind-proxy',
    'PULSE_HTTP_PORT=8080',
  ];
  if (creds.relaySubdomain && creds.relayServerAddr && creds.relayTunnelToken) {
    lines.push(
      `PULSE_RELAY_SUBDOMAIN=${creds.relaySubdomain}`,
      `PULSE_RELAY_SERVER_ADDR=${creds.relayServerAddr}`,
      `PULSE_RELAY_TUNNEL_TOKEN=${creds.relayTunnelToken}`,
    );
  }
  return lines.join('\n') + '\n';
}

export class ContainerBackendManager {
  private rt: ContainerRuntime | null = null;

  /** Runtime lazy erkennen + cachen (einmal gefunden, bleibt sie stehen). */
  private async ensureRuntime(): Promise<ContainerRuntime | null> {
    if (!this.rt) this.rt = await detectRuntime();
    return this.rt;
  }

  /** Für das UI-Gating: gibt es überhaupt eine Runtime? (gecacht nach Erfolg) */
  async runtimeAvailable(): Promise<boolean> {
    return (await this.ensureRuntime()) !== null;
  }

  /** Erkannte Runtime (lazy) — für Plattform-Prereq-Checks (WSL-Assistent). */
  async runtime(): Promise<ContainerRuntime | null> {
    return this.ensureRuntime();
  }

  async start(opts: {
    userData: string;
    creds: BootstrapCreds;
    adminEmail?: string;
    onProgress?: (step: string) => void;
  }): Promise<void> {
    const { userData, creds, adminEmail, onProgress } = opts;
    const progress = onProgress ?? (() => {});

    const rt = await this.ensureRuntime();
    if (!rt) {
      throw new Error('no container runtime found (podman/docker)');
    }

    // 0. Win/Mac + Podman: Linux-VM hochfahren (Linux/Docker: No-op).
    await ensureMachine(rt, progress);

    // 1. Env-Datei (0600) — einzige Stelle mit Klartext-Secrets auf der Platte.
    const dir = join(userData, 'pulse-host');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const envFile = join(dir, 'container.env');
    writeFileSync(envFile, renderContainerEnv(creds, adminEmail), {
      encoding: 'utf8',
      mode: 0o600,
    });

    const { image, local } = resolveImage();
    if (!local) {
      // 2. Registry-Login mit den Instanz-Creds (Pull-Gate der eigenen Registry).
      progress('login');
      const registry = image.split('/', 1)[0];
      const login = await rtExec(
        rt,
        ['login', registry, '-u', creds.clientId, '--password-stdin'],
        { stdin: creds.clientSecret, timeoutMs: 30_000 },
      );
      if (login.code !== 0) {
        throw new Error(`registry login failed (exit ${login.code})`);
      }

      // 3. Pull — beim Erststart mehrere hundert MB, danach Digest-Check (= Update).
      progress('pull');
      const pull = await rtExec(rt, ['pull', image], { timeoutMs: 15 * 60_000 });
      if (pull.code !== 0) {
        throw new Error(`image pull failed (exit ${pull.code})`);
      }
    }

    // 4. Alten Container ersetzen (Recreate statt Restart → nimmt frisch
    //    gepullte Images + Env-Änderungen mit; /data lebt im Named Volume).
    progress('run');
    await rtExec(rt, ['rm', '-f', CONTAINER_NAME], { timeoutMs: 60_000 });
    const run = await rtExec(rt, [
      'run', '-d',
      '--name', CONTAINER_NAME,
      '--restart', 'unless-stopped',
      '--env-file', envFile,
      '-v', `${DATA_VOLUME}:/data`,
      '-p', `127.0.0.1:${HOST_HTTP_PORT}:8080`,
      ...MEDIA_PORT_ARGS,
      image,
    ], { timeoutMs: 120_000 });
    if (run.code !== 0) {
      throw new Error(`container start failed (exit ${run.code}): ${run.stderr.slice(0, 400)}`);
    }

    // 5. Health-Poll — Erststart braucht initdb + Migrationen (Image-Healthcheck
    //    rechnet mit 120s start-period; wir geben 240s). waitFor wirft bei Timeout.
    progress('health');
    await waitFor(
      () => httpHealth(`http://127.0.0.1:${HOST_HTTP_PORT}/api/chat/health`),
      240_000,
      3_000,
    );
  }

  async stop(): Promise<void> {
    const rt = await this.ensureRuntime();
    if (!rt) return;
    // -t 20: Postgres im Container sauber runterfahren lassen.
    await rtExec(rt, ['stop', '-t', '20', CONTAINER_NAME], {
      timeoutMs: 60_000,
    }).catch(() => {});
  }
}
