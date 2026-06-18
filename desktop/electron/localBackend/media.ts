// Renderer für die nativen Medien-Dienste (LiveKit + MediaMTX) im Self-Host-Stack.
// Configs binden 0.0.0.0 (Medien müssen von außen erreichbar sein); feste Ports
// für 1:1-Port-Forwarding. LiveKit ermittelt seine öffentliche IP per STUN
// (use_external_ip) und bringt einen eingebauten UDP-TURN mit (kein coturn).

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
