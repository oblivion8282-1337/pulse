// frpc client config (TOML, frp >=0.58). Der frps-Server routet
// <slug>.<subdomainHost> in diesen Tunnel; das Server-Plugin autorisiert die
// Anmeldung per Auth-Hook. Token reist nur als metadata — nie loggen.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveBinary } from './paths.ts';
import { tcpProbe } from './health.ts';
import type { DataDirs } from './types.ts';
import type { SupervisedProcessSpec } from './process.ts';

export const FRPC_PROXY_SUFFIX = '-chat';
const DEFAULT_BASE_DOMAIN = 'relay.howispulse.com';

/** Erstes DNS-Label der vollen Subdomain (der frp-Routing-Slug). */
function slugOf(fullSubdomain: string): string {
  return fullSubdomain.split('.', 1)[0];
}

export function renderFrpcConfig(input: {
  relayServerAddr: string;   // host:port
  authToken: string;
  localChatPort: number;
  fullSubdomain: string;
  baseDomain: string;
}): string {
  const [host, port] = input.relayServerAddr.split(':');
  const slug = slugOf(input.fullSubdomain);
  return [
    `serverAddr = "${host}"`,
    `serverPort = ${Number(port)}`,
    `user = "${input.fullSubdomain}"`,
    `metadatas.token = "${input.authToken}"`,
    '',
    '[[proxies]]',
    `name = "${input.fullSubdomain}${FRPC_PROXY_SUFFIX}"`,
    'type = "http"',
    `localPort = ${input.localChatPort}`,
    `subdomain = "${slug}"`,
    `metadatas.token = "${input.authToken}"`,
    '',
  ].join('\n');
}

export interface TunnelRelay {
  serverAddr: string;
  authToken: string;
  subdomain: string;   // volle Subdomain (<slug>.<baseDomain>)
}

export function tunnelComponent(input: {
  dirs: DataDirs;
  relay: TunnelRelay;
  chatPort: number;
  baseDomain?: string;
}): SupervisedProcessSpec {
  const { dirs, relay, chatPort } = input;
  const baseDomain = input.baseDomain ?? DEFAULT_BASE_DOMAIN;
  const configPath = join(dirs.root, 'frpc.toml');

  const toml = renderFrpcConfig({
    relayServerAddr: relay.serverAddr,
    authToken: relay.authToken,
    localChatPort: chatPort,
    fullSubdomain: relay.subdomain,
    baseDomain,
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
    healthCheck: () => tcpProbe(chatPort),
    restartMax: 5,
  };
}
