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
 * und wie 09-init-caddy.sh behind-proxy gepatcht — Site-Adresse auf 127.0.0.1:8080,
 * plus Desktop-Health-Listener 127.0.0.1:55580 am selben Site-Block.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NATIVE_PORTS, NATIVE_MEDIA_PORTS } from './types.ts';
import type { NativeSecrets } from './types.ts';
import { templatesDir } from './paths.ts';

/** `oeffentlicheIp` gesetzt: feste `node_ip` statt STUN — LiveKit schaltet
 *  sonst Firefox auf „nur öffentliche Adresse" um, und ein Firefox-Gast im
 *  selben Heimnetz scheitert am fehlenden Hairpin-NAT (oeffentlicheIp.ts). */
export function renderLivekitYaml(secrets: NativeSecrets, voicePort: number, oeffentlicheIp?: string): string {
  return `port: ${NATIVE_PORTS.livekitApi}
# Signal/Twirp-API nur auf Loopback — von außen kommt man ausschließlich über
# Caddy (/livekit, erreicht über frpc oder den direct-adapter, beide lokal).
# bind_addresses betrifft in LiveKit 1.13.3 nur die HTTP-Listener
# (pkg/service/server.go); die RTC-Ports (tcp_port, UDP-Bereich) richtet
# rtcconfig.NewWebRTCConfig unabhängig davon ein — Medien bleiben erreichbar.
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: ${NATIVE_PORTS.livekitRtcTcp}
  port_range_start: ${NATIVE_MEDIA_PORTS.livekitUdpStart}
  port_range_end: ${NATIVE_MEDIA_PORTS.livekitUdpEnd}
  # Öffentliche Adresse: fest vorgegeben, wenn die Server-App sie ermitteln
  # konnte (s. renderLivekitYaml-Kommentar); sonst STUN in LiveKit selbst —
  # nativ sieht STUN die echte öffentliche IP, kein WSL-Doppel-NAT davor.
${oeffentlicheIp
    ? `  use_external_ip: false\n  node_ip: ${oeffentlicheIp}`
    : '  use_external_ip: true\n  skip_external_ip_validation: true'}
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
# App-Host hinter Heim-NAT — Container-Parität aus 08-init-mediamtx.sh
# (App-Host-Zweig): MediaMTX holt sich per STUN selbst den srflx-Kandidaten
# und locht durchs NAT (wie LiveKit use_external_ip / direct-adapter) —
# die Heim-IP wechselt, eine statische AdditionalHosts-IP wäre falsch.
# 0.0.0.0 statt :PORT bindet IPv4-only: mit Dual-Stack funkte MediaMTX an
# die IPv6-Adresse des Zuschauers, die kein Heim-Router hereinlässt
# (gemessen 2026-07-10: 312 Pakete raus, 0 zurück).
webrtcLocalUDPAddress: 0.0.0.0:${NATIVE_MEDIA_PORTS.mtxWebrtcUdp}
webrtcIPsFromInterfaces: yes
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302
  - url: stun:stun.cloudflare.com:3478
hls: no
moq: no

authMethod: http
authHTTPAddress: http://127.0.0.1:${mtxHookPort}
# "api" steht hier bewusst NICHT (wie 08-init-mediamtx.sh): die API-Anfragen
# gehen an den Hook, der MEDIAMTX_API_PASSWORD prüft. Die Loopback-Bindung
# allein ist kein Zugangsschutz — auf dem Rechner laufen weitere Prozesse,
# darunter der direct-adapter, der Anfragen im Auftrag Fremder stellt.
authHTTPExclude:
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
 * Garnet-Config (Format „GarnetConf“, Schlüssel wie in Garnets defaults.conf):
 * nur die Passwort-Anmeldung — über eine Datei statt `--password`, damit das
 * Geheimnis nicht in der Prozessliste steht. Die übrigen Optionen bleiben
 * auf der Kommandozeile (components.ts).
 */
export function renderGarnetConf(password: string): string {
  return JSON.stringify({ AuthenticationMode: 'Password', Password: password });
}

/**
 * frpc.toml für den Steuerungs-Relay-Tunnel — Portierung von
 * 11-render-frpc.sh. Der Tunnel trägt NICHT den Chat (Direktpfad), sondern
 * die Browser-eigenen Verbindungen auf den Relay-Hostnamen: LiveKit-Signal
 * (/livekit) und WHEP-Playback (/whep). Ohne ihn ist eine App-Host-Instanz
 * von außen stimm- und streamlos (Linux-Container startet denselben frpc).
 * Secrets (Tunnel-Token) stehen in der Datei — niemals loggen.
 */
export function renderFrpcToml(
  subdomain: string,
  serverAddr: string,
  tunnelToken: string,
  localHttpPort: number,
): string {
  const host = serverAddr.split(':')[0];
  const port = serverAddr.split(':')[1] ?? '7000';
  const slug = subdomain.split('.')[0];
  return `# gerendert vom nativeBackendManager — Steuerungs-Relay (App-Hosting)
serverAddr = "${host}"
serverPort = ${parseInt(port, 10)}
user = "${subdomain}"
metadatas.token = "${tunnelToken}"
# Bei Login-Fehler (Relay down, Token noch nicht aktiv) intern retryen statt
# exiten — sonst zehrt der Crash-Loop das restart-gate auf (wie im Image).
loginFailExit = false

[[proxies]]
name = "${slug}-http"
type = "http"
localPort = ${localHttpPort}
subdomain = "${slug}"
metadatas.token = "${tunnelToken}"
`;
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
  // Beide auf Loopback: der Klartext-Eingang :8080 wird nur von frpc und vom
  // direct-adapter angesprochen (beide 127.0.0.1). Auf allen Interfaces
  // stünde die ganze API unverschlüsselt im Heimnetz.
  const siteAdresse = `http://127.0.0.1:${httpPort}, http://127.0.0.1:${desktopPort} {`;
  const patched = text.replace('{$PULSE_HOSTNAME} {', siteAdresse);
  if (!patched.includes(siteAdresse)) {
    throw new Error('[native] Caddyfile-Patch fehlgeschlagen — Site-Adresse nicht gefunden.');
  }
  // Zweit-Site-Block (http://:8080 { import pulseconfig }) entfernen — die
  // Adressen leben jetzt im ersten Block, ein Duplikat wäre mehrdeutig.
  text = patched.replace(/\nhttp:\/\/:8080 \{\n\s*import pulseconfig\n\}\s*$/, '\n');
  return text;
}
