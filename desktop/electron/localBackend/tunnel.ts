// frpc client config (TOML, frp >=0.58). Der frps-Server routet
// <slug>.<subdomainHost> in diesen Tunnel; das Server-Plugin autorisiert die
// Anmeldung per Auth-Hook. Token reist nur als metadata — nie loggen.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveBinary } from './paths.ts';
import { tcpProbe } from './health.ts';
import type { DataDirs } from './types.ts';
import type { SupervisedProcessSpec } from './process.ts';

export interface FrpcServicePorts {
  auth: number;
  chat: number;
  voice: number;
  livekit: number;
  whep: number;
  hls: number;
}

export interface TunnelRelay {
  serverAddr: string;
  authToken: string;
  subdomain: string;   // volle Subdomain (<slug>.<baseDomain>)
}

function proxyBlock(name: string, slug: string, port: number, locations: string[], token: string): string[] {
  const locs = locations.map((l) => `"${l}"`).join(', ');
  return [
    '[[proxies]]',
    `name = "${name}"`,
    'type = "http"',
    `localPort = ${port}`,
    `subdomain = "${slug}"`,
    `locations = [${locs}]`,
    `metadatas.token = "${token}"`,
    '',
  ];
}

export function renderFrpcConfig(input: {
  relayServerAddr: string;
  authToken: string;
  fullSubdomain: string;
  /** Akzeptiert, aber nicht ausgewertet — der Slug ergibt sich aus fullSubdomain. */
  baseDomain?: string;
  ports: FrpcServicePorts;
}): string {
  const [host, port] = input.relayServerAddr.split(':');
  const slug = input.fullSubdomain.split('.', 1)[0];
  const token = input.authToken;
  const p = input.ports;

  // Ein Proxy pro Pfadgruppe; alle teilen Slug + Token. Default-Proxy ("/") fängt den Rest.
  const proxies: Array<[string, number, string[]]> = [
    ['auth', p.auth, ['/api/auth']],
    ['chat', p.chat, ['/api/chat', '/api/ws']],
    ['voice', p.voice, ['/api/voice']],
    ['livekit', p.livekit, ['/livekit']],
    ['whep', p.whep, ['/whep']],
    ['hls', p.hls, ['/hls']],
    ['default', p.chat, ['/']],
  ];

  const lines = [
    `serverAddr = "${host}"`,
    `serverPort = ${Number(port)}`,
    `user = "${input.fullSubdomain}"`,
    `metadatas.token = "${token}"`,
    '',
    ...proxies.flatMap(([suffix, localPort, locations]) =>
      proxyBlock(`${slug}-${suffix}`, slug, localPort, locations, token),
    ),
  ];
  return lines.join('\n');
}

export function tunnelComponent(input: {
  dirs: DataDirs;
  relay: TunnelRelay;
  ports: FrpcServicePorts;
}): SupervisedProcessSpec {
  const { dirs, relay, ports } = input;
  const configPath = join(dirs.root, 'frpc.toml');

  const toml = renderFrpcConfig({
    relayServerAddr: relay.serverAddr,
    authToken: relay.authToken,
    fullSubdomain: relay.subdomain,
    ports,
  });
  // NEVER log the rendered TOML (contains authToken)
  writeFileSync(configPath, toml, { encoding: 'utf8', mode: 0o600 });

  return {
    name: 'tunnel',
    command: resolveBinary('frpc'),
    args: ['-c', configPath],
    env: {},
    // Probt den lokalen chat-gateway-Port (vor dem Tunnel-Start up) — bestätigt
    // NICHT die Relay-Erreichbarkeit; das prüft der Integrationstest (Task 5).
    healthCheck: () => tcpProbe(ports.chat),
    restartMax: 5,
  };
}
