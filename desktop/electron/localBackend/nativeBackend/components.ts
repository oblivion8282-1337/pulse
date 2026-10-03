/**
 * Service-Specs für das native Backend — das Gegenstück zur s6-rc.d-Liste
 * des allinone-Images (18 Units → bis zu 15 Prozessen; entfallen: coturn
 * [kein Windows-Build; LiveKit-embedded-TURN/kein TURN — Semantik wie
 * PULSE_TURN_DISABLED=true], udp-gateway [nur für WSL/gvproxy-NAT nötig],
 * backup [v2: pg_dump-Timer], garage-init [weed braucht keine Init-Unit]).
 * frpc (Steuerungs-Relay für /livekit + /whep) gehört DAZU — der Beschluss
 * „kein Relay" (2026-09-27) betraf nur den Chat-Datenweg (Direktpfad).
 *
 * Startreihenfolge = Abhängigkeitsreihenfolge; der Manager gate't jeden
 * Schritt mit healthCheck, deshalb keine sleep-Ketten wie in s6.
 */

import { join } from 'node:path';

import { httpHealth, tcpProbe } from '../health.ts';
import {
  resolveNativeBin,
  venvPython,
  serviceDir,
  servicePythonPath,
  pgBin,
  nativeRoot,
} from './paths.ts';
import { postgresArgs } from './postgres.ts';
import { NATIVE_PORTS } from './types.ts';
import type { ServiceSpec } from './types.ts';
import type { NativeDataDirs, NativeSecrets } from './types.ts';
import type { NativeIdentity } from './envContract.ts';

/** Trivial-Health für UDP-only-Dienste (direct-adapter): der Supervisor
 *  fängt Exits über onExit, ein Port-Beep gibt es nicht. */
const alwaysHealthy = async (): Promise<boolean> => true;

function uvicornSpec(
  svcName: string,
  pkgModule: string,
  port: number,
  env: Record<string, string>,
): ServiceSpec {
  const py = venvPython();
  return {
    name: svcName,
    command: py,
    args: ['-m', 'uvicorn', pkgModule, '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
    env: { ...env, PYTHONPATH: servicePythonPath() },
    cwd: serviceDir(svcName),
    healthCheck: () => httpHealth(`http://127.0.0.1:${port}/health`),
  };
}

export interface NativeComponentsInput {
  dirs: NativeDataDirs;
  secrets: NativeSecrets;
  env: Record<string, string>;
  identity: NativeIdentity;
  /** Gerenderte Config-Dateien (der Manager schreibt sie vorher). */
  livekitYamlPath: string;
  mediamtxYmlPath: string;
  caddyfilePath: string;
  weedS3JsonPath: string;
  /** frpc.toml — null ohne Relay-Creds (VPS/o.ä.): Prozess bleibt dann aus. */
  frpcTomlPath: string | null;
}

/**
 * Alle Prozess-Specs in Startreihenfolge:
 * postgres → garnet → weed(master/volume/filer/s3) → caddy → auth →
 * media-svc → mtx-hook → voice-signaling → livekit → mediamtx → chat-gateway.
 */
export function nativeComponents(
  input: NativeComponentsInput,
): (ServiceSpec & { gracefulStop?: () => Promise<void> })[] {
  const { dirs, livekitYamlPath, mediamtxYmlPath, caddyfilePath, weedS3JsonPath } = input;
  const p = NATIVE_PORTS;

  const postgres = {
    name: 'postgres',
    command: pgBin('postgres'),
    args: postgresArgs(dirs),
    env: {},
    healthCheck: () => tcpProbe(p.postgres),
  };

  const garnet: ServiceSpec = {
    name: 'garnet',
    command: resolveNativeBin('garnet/GarnetServer'),
    args: ['--bind', '127.0.0.1', '--port', String(p.garnet), '--logger-level', 'Warning',
      // Container-Redis hat Lua immer an — die Services nutzen EVAL breit
      // (auth-hook Consume-once, watch-keys, media-svc, voice-webhook).
      // transaction-mode schließt die Keys während der Ausführung ≙
      // Redis-Atomizität, die die Skripte voraussetzen.
      '--lua', '--lua-transaction-mode'],
    // Release-Zip ist runtime-abhängig → DOTNET_ROOT auf die gebündelte
    // .NET-Runtime (fetch-win-native.ps1 legt native-bin/dotnet/ an).
    env: { DOTNET_ROOT: join(nativeRoot(), 'native-bin', 'dotnet') },
    // ponytail: ohne AOF/Persistenz — Redis-Inhalt ist Replay-Cache
    // (Hist/TTL/Seq), füllt sich aus Postgres wieder; der Container lief mit
    // appendonly yes. Upgrade-Pfad: Garnet-AOF-Flag, sobald Parität getestet.
    healthCheck: () => tcpProbe(p.garnet),
  };

  const weedMaster: ServiceSpec = {
    name: 'weed-master',
    command: resolveNativeBin('weed'),
    args: ['master', '-port', String(p.weedMaster), '-ip', '127.0.0.1', '-mdir', dirs.weedMaster, '-volumeSizeLimitMB', '1024', '-defaultReplication', '000'],
    env: {},
    healthCheck: () => tcpProbe(p.weedMaster),
  };
  const weedVolume: ServiceSpec = {
    name: 'weed-volume',
    command: resolveNativeBin('weed'),
    args: ['volume', '-port', String(p.weedVolume), '-ip', '127.0.0.1', '-dir', dirs.weedVolume, '-max', '0', '-mserver', `127.0.0.1:${p.weedMaster}`],
    env: {},
    healthCheck: () => tcpProbe(p.weedVolume),
  };
  const weedFiler: ServiceSpec = {
    name: 'weed-filer',
    command: resolveNativeBin('weed'),
    args: ['filer', '-port', String(p.weedFiler), '-ip', '127.0.0.1', '-master', `127.0.0.1:${p.weedMaster}`, '-defaultStoreDir', dirs.weedFiler],
    env: {},
    healthCheck: () => tcpProbe(p.weedFiler),
  };
  const weedS3: ServiceSpec = {
    name: 'weed-s3',
    command: resolveNativeBin('weed'),
    args: ['s3', '-port', String(p.s3), '-ip', '127.0.0.1', '-filer', `127.0.0.1:${p.weedFiler}`, '-config', weedS3JsonPath],
    env: {},
    healthCheck: () => tcpProbe(p.s3),
  };

  const caddy: ServiceSpec = {
    name: 'caddy',
    command: resolveNativeBin('caddy'),
    args: ['run', '--config', caddyfilePath, '--adapter', 'caddyfile'],
    env: { ...input.env },
    healthCheck: () => tcpProbe(p.caddyDesktop),
  };

  const auth = uvicornSpec('auth', 'dcc_auth.app:app', p.auth, input.env);
  const mediaSvc = uvicornSpec('media-svc', 'dcc_media_svc.app:app', p.media, input.env);
  const mtxHook = uvicornSpec('mediamtx-auth-hook', 'dcc_mediamtx_auth_hook.app:app', p.mtxHook, input.env);
  const voiceSignaling = uvicornSpec('voice-signaling', 'dcc_voice_signaling.app:app', p.voice, input.env);

  const livekit: ServiceSpec = {
    name: 'livekit',
    command: resolveNativeBin('livekit-server'),
    args: ['--config', livekitYamlPath],
    env: {},
    healthCheck: () => tcpProbe(p.livekitApi),
  };

  const mediamtx: ServiceSpec = {
    name: 'mediamtx',
    command: resolveNativeBin('mediamtx'),
    args: [mediamtxYmlPath],
    env: { PULSE_KEYFRAME_INTERVAL: '0' },
    healthCheck: () => tcpProbe(9997),
  };

  const chatGateway = uvicornSpec('chat-gateway', 'dcc_chat_gateway.app:app', p.chat, input.env);

  // Direktpfad-Adapter (WebRTC-DataChannel-Brücke → 127.0.0.1:8080). Optional:
  // fehlt die Binary (CI-Artifact noch nicht da), startet der Rest trotzdem.
  let directAdapter: ServiceSpec | null = null;
  try {
    directAdapter = {
      name: 'direct-adapter',
      command: resolveNativeBin('direct-adapter'),
      args: [],
      env: { ...input.env },
      // Nativ sieht der Adapter die echten Interfaces → kein
      // PULSE_DIRECT_EXTRA_HOST_IPS (Container-Sonderweg für die VM-IP).
      healthCheck: alwaysHealthy,
    };
  } catch {
    console.error('[native] direct-adapter.exe fehlt — Direktpfad deaktiviert.');
  }

  // Steuerungs-Relay-Tunnel (App-Hosting): trägt LiveKit-Signal (/livekit)
  // und WHEP-Playback (/whep) auf den Relay-Hostnamen — der Chat läuft separat
  // über den Direktpfad. Optional wie im Image: ohne Relay-Creds (VPS) bleibt
  // der frpc-longrun dort schlafen, hier startet er schlicht nicht.
  let frpc: ServiceSpec | null = null;
  if (input.frpcTomlPath) {
    try {
      frpc = {
        name: 'frpc',
        command: resolveNativeBin('frpc'),
        args: ['-c', input.frpcTomlPath],
        env: {},
        // loginFailExit=false lässt frpc selbst retryen; der Tunnel-Erfolg
        // zeigt sich am Relay-Hostnamen, nicht an einem lokalen Port.
        healthCheck: alwaysHealthy,
      };
    } catch {
      console.error('[native] frpc.exe fehlt — Steuerungs-Relay (Voice/Stream von außen) deaktiviert.');
    }
  }

  return [
    postgres,
    garnet,
    weedMaster,
    weedVolume,
    weedFiler,
    weedS3,
    caddy,
    auth,
    mediaSvc,
    mtxHook,
    voiceSignaling,
    livekit,
    mediamtx,
    chatGateway,
    ...(directAdapter ? [directAdapter] : []),
    ...(frpc ? [frpc] : []),
  ];
}
