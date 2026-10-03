/**
 * Config-Renderer für die nativen Go/Caddy-Dienste.
 *
 * livekit.yaml + mediamtx.yml werden direkt gerendert (MVP-Fassung aus
 * 05-init-livekit.sh / 08-init-mediamtx.sh, aber OHNE die VM-Sonderwege:
 * nativ sieht jeder Dienst die echten Interfaces → use_external_ip /
 * webrtcIPsFromInterfaces: yes funktionieren wie auf einem Linux-VPS).
 * ponytail: hält sich an die Templates im Image — bei Änderungen dort
 * hier mitziehen (grep nach use_external_ip / webrtcLocalUDPAddress).
 *
 * Caddyfile: Template des Images wird VERBATIM übernommen (Route-Parität!)
 * und wie 09-init-caddy.sh behind-proxy gepatcht — Site-Adresse auf :8080,
 * plus Desktop-Health-Listener 127.0.0.1:55580 am selben Site-Block.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NATIVE_PORTS, NATIVE_MEDIA_PORTS } from './types.ts';
import type { NativeSecrets } from './types.ts';
import { templatesDir } from './paths.ts';

export function renderLivekitYaml(secrets: NativeSecrets, voicePort: number): string {
  return `port: ${NATIVE_PORTS.livekitApi}
bind_addresses:
  - 0.0.0.0
rtc:
  tcp_port: ${NATIVE_PORTS.livekitRtcTcp}
  port_range_start: ${NATIVE_MEDIA_PORTS.livekitUdpStart}
  port_range_end: ${NATIVE_MEDIA_PORTS.livekitUdpEnd}
  # Nativ: STUN sieht die echte öffentliche IP, kein WSL-Doppel-NAT davor —
  # der Standardweg wie auf einem VPS (livekit.yaml.template: use_external_ip).
  use_external_ip: true
  skip_external_ip_validation: true
  advertise_internal_ip: true
  # IPv6-Kandidaten unterdrücken — gleiche Begründung wie im Template
  # (Fritz!Box blockt eingehendes IPv6 → Gäste hängen nur in Timeouts).
  ips:
    excludes:
      - "::/0"
keys:
  ${secrets.livekitApiKey}: "${secrets.livekitApiSecret}"
webhook:
  api_key: ${secrets.livekitApiKey}
  urls:
    - http://127.0.0.1:${voicePort}/webhook
log_level: info
`;
}

export function renderMediamtxYml(hostname: string, certDir: string, mtxHookPort: number): string {
  return `logLevel: info
logDestinations: [stdout]

# Schreibpuffer je Leser — wie infra/prod/mediamtx.yml (Sendestau-Deckel).
writeQueueSize: 2048

api: yes
apiAddress: 127.0.0.1:9997

rtmp: yes
rtmpEncryption: optional
rtmpAddress: :1935
rtmpsAddress: :${NATIVE_MEDIA_PORTS.rtmps}
rtmpServerCert: ${join(certDir, 'mediamtx.crt').replace(/\\/g, '/')}
rtmpServerKey: ${join(certDir, 'mediamtx.key').replace(/\\/g, '/')}

webrtc: yes
webrtcAddress: 127.0.0.1:8889
webrtcEncryption: no
# NATIV: die echten LAN-Interfaces sind sichtbar (kein WSL-NAT) — der
# Standardweg wie auf dem VPS. 8189/udp muss LAN-erreichbar bleiben.
webrtcLocalUDPAddress: :${NATIVE_MEDIA_PORTS.mtxWebrtcUdp}
webrtcIPsFromInterfaces: yes
hls: no
moq: no

authMethod: http
authHTTPAddress: http://127.0.0.1:${mtxHookPort}
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

# HQ-Kanal-Streams nutzen dynamische Pfade (channel-<id>-<uid>-<nonce>) —
# Catch-all wie im Image; der Auth-Hook entscheidet je Verbindung.
paths:
  all_others:
`;
}

/** s3.json für weed — Identity-Format aus iam_pb.Identity (4.48):
 *  credentials[{accessKey,secretKey}] + sts.signingKey (Base64). */
export function renderWeedS3Config(
  minioUser: string,
  minioPassword: string,
  signingKeyB64: string,
): string {
  return JSON.stringify({
    sts: { signingKey: signingKeyB64 },
    identities: [
      {
        name: 'pulse',
        credentials: [{ accessKey: minioUser, secretKey: minioPassword }],
        actions: ['Admin', 'Read', 'Write', 'List'],
      },
    ],
  });
}

/**
 * Caddyfile aus dem Image-Template rendern (behind-proxy-Patch wie
 * 09-init-caddy.sh, plus Desktop-Listener 127.0.0.1:55580 am selben Block).
 * Das Template hardcodet die internen Ports (8001-8005/7880/8889/9000) —
 * deshalb müssen die nativen Dienste EXAKT dort lauschen (NATIVE_PORTS).
 */
export function renderCaddyfile(httpPort: number, desktopPort: number, caddyRoot?: string): string {
  const tplPath = join(caddyRoot ?? templatesDir(), 'Caddyfile.template');
  let text = readFileSync(tplPath, 'utf8');
  // Site-Adresse Hostname → beide HTTP-Listener (wie behind-proxy, nur mit
  // zusätzlichem Desktop-Port — Caddy akzeptiert kommagetrennte Adressen).
  const patched = text.replace(
    '{$PULSE_HOSTNAME} {',
    `http://:${httpPort}, http://127.0.0.1:${desktopPort} {`,
  );
  if (!patched.includes(`http://:${httpPort}, http://127.0.0.1:${desktopPort} {`)) {
    throw new Error('[native] Caddyfile-Patch fehlgeschlagen — Site-Adresse nicht gefunden.');
  }
  // Zweit-Site-Block (http://:8080 { import pulseconfig }) entfernen — die
  // Adressen leben jetzt im ersten Block, ein Duplikat wäre mehrdeutig.
  text = patched.replace(/\nhttp:\/\/:8080 \{\n\s*import pulseconfig\n\}\s*$/, '\n');
  return text;
}
