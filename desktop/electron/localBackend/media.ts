// Renderer + Prozess-Specs für die nativen Medien-Dienste (LiveKit + MediaMTX).
// Configs binden 0.0.0.0 (Medien müssen von außen erreichbar sein); feste Ports
// für 1:1-Port-Forwarding. LiveKit ermittelt seine öffentliche IP per STUN
// (use_external_ip) und bringt einen eingebauten UDP-TURN mit (kein coturn).

import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from './paths.ts';
import { tcpProbe } from './health.ts';
import { ensureMediamtxCert } from './secrets.ts';
import type { SupervisedProcessSpec } from './process.ts';
import type { DataDirs } from './types.ts';
import type { Secrets } from './secrets.ts';

export const MEDIA_STUN_URL = 'stun:stun.l.google.com:19302';

export function renderLivekitConfig(input: {
  apiKey: string; apiSecret: string; voicePort: number; domain: string;
}): string {
  return [
    'port: 7880',
    'bind_addresses:',
    '  - 0.0.0.0',
    'rtc:',
    '  tcp_port: 7881',
    '  port_range_start: 7882',
    '  port_range_end: 7892',
    '  use_external_ip: true',
    'turn:',
    '  enabled: true',
    '  udp_port: 3478',
    `  domain: ${input.domain}`,
    'keys:',
    `  ${input.apiKey}: ${input.apiSecret}`,
    'webhook:',
    `  api_key: ${input.apiKey}`,
    '  urls:',
    `    - http://127.0.0.1:${input.voicePort}/webhook`,
    '',
  ].join('\n');
}

export function renderMediamtxConfig(input: {
  certPath: string; keyPath: string; authHookPort: number;
  additionalHost: string; stunUrl: string;
}): string {
  return [
    'logLevel: info',
    'logDestinations: [stdout]',
    'api: yes',
    'apiAddress: 127.0.0.1:9997',
    'rtmp: yes',
    'rtmpEncryption: optional',
    'rtmpAddress: :1935',
    'rtmpsAddress: :1936',
    `rtmpServerCert: ${input.certPath}`,
    `rtmpServerKey: ${input.keyPath}`,
    'webrtc: yes',
    'webrtcAddress: :8889',
    'webrtcEncryption: no',
    'webrtcLocalUDPAddress: :8189',
    'webrtcIPsFromInterfaces: no',
    `webrtcAdditionalHosts: [${input.additionalHost}]`,
    'webrtcICEServers2:',
    `  - url: ${input.stunUrl}`,
    'hls: yes',
    'hlsAddress: :8888',
    'authMethod: http',
    `authHTTPAddress: http://127.0.0.1:${input.authHookPort}`,
    'authHTTPExclude:',
    '  - action: api',
    '  - action: metrics',
    '  - action: pprof',
    'paths:',
    '  all_others:',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// mediaComponents — schreibt Configs auf Disk und baut SupervisedProcessSpecs
// ---------------------------------------------------------------------------

/** Schreibt content nach filePath (utf8, mode 0o600 auf non-Windows). */
function writeSecretFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8' });
  if (process.platform !== 'win32') chmodSync(filePath, 0o600);
}

interface MediaComponentsInput {
  dirs: DataDirs;
  secrets: Secrets;
  env: Record<string, string>;
  voicePort: number;
  authHookPort: number;
  domain: string;
}

/**
 * Schreibt livekit.yaml + mediamtx.yml nach dirs.root (mode 0o600),
 * stellt den MediaMTX-RTMPS-Cert sicher und gibt [livekitSpec, mediamtxSpec] zurück.
 *
 * Configs werden NICHT geloggt (Secret-Hygiene: LiveKit-API-Secret + RTMPS-Key).
 */
export function mediaComponents(input: MediaComponentsInput): SupervisedProcessSpec[] {
  const { dirs, secrets, env, voicePort, authHookPort, domain } = input;

  // Resolve binaries early — both are independent lookups.
  const livekitBin = resolveBinary('livekit-server');
  const mediamtxBin = resolveBinary('mediamtx');

  const { certPath, keyPath } = ensureMediamtxCert(dirs.secrets, domain);

  const livekitCfg = join(dirs.root, 'livekit.yaml');
  writeSecretFile(livekitCfg, renderLivekitConfig({
    apiKey: secrets.livekitApiKey,
    apiSecret: secrets.livekitApiSecret,
    voicePort,
    domain,
  }));

  const mediamtxCfg = join(dirs.root, 'mediamtx.yml');
  writeSecretFile(mediamtxCfg, renderMediamtxConfig({
    certPath, keyPath,
    authHookPort,
    additionalHost: domain,
    stunUrl: MEDIA_STUN_URL,
  }));

  return [
    {
      name: 'livekit',
      command: livekitBin,
      args: ['--config', livekitCfg],
      env,
      healthCheck: () => tcpProbe(7880),
      restartMax: 5,
    },
    {
      name: 'mediamtx',
      command: mediamtxBin,
      args: [mediamtxCfg],
      env,
      // MediaMTX schreibt sein WebRTC-Default-Cert (auto.crt/auto.key) ins
      // Arbeitsverzeichnis → in den Daten-Ordner lenken, nicht ins cwd des Prozesses.
      cwd: dirs.root,
      healthCheck: () => tcpProbe(9997),
      restartMax: 5,
    },
  ];
}
