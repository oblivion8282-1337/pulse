// rathole client config (TOML). Der Relay-Server kennt denselben Service-Namen
// + Token und exponiert ihn unter der Subdomain (TLS terminiert am Relay).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveBinary } from './paths.ts';
import { tcpProbe } from './health.ts';
import type { DataDirs } from './types.ts';
import type { SupervisedProcessSpec } from './process.ts';

export const RATHOLE_TUNNEL_NAME = 'pulse-chat';

export function renderRatholeClientConfig(input: {
  relayServerAddr: string;
  authToken: string;
  localChatPort: number;
  tunnelName: string;
}): string {
  return [
    '[client]',
    `remote_addr = "${input.relayServerAddr}"`,
    `default_token = "${input.authToken}"`,
    '',
    `[client.services.${input.tunnelName}]`,
    'type = "tcp"',
    `local_addr = "127.0.0.1:${input.localChatPort}"`,
    '',
  ].join('\n');
}

export interface TunnelRelay {
  serverAddr: string;
  authToken: string;
  subdomain: string;
}

/**
 * Baut die SupervisedProcessSpec für den rathole-Client-Tunnel.
 * Schreibt die Client-TOML nach `dirs.root/rathole-client.toml` (kein Token-Logging).
 */
export function tunnelComponent(input: {
  dirs: DataDirs;
  relay: TunnelRelay;
  chatPort: number;
}): SupervisedProcessSpec {
  const { dirs, relay, chatPort } = input;
  const configPath = join(dirs.root, 'rathole-client.toml');

  const toml = renderRatholeClientConfig({
    relayServerAddr: relay.serverAddr,
    authToken: relay.authToken,
    localChatPort: chatPort,
    tunnelName: RATHOLE_TUNNEL_NAME,
  });
  // NEVER log the rendered TOML (contains authToken)
  writeFileSync(configPath, toml, { encoding: 'utf8', mode: 0o600 });

  return {
    name: 'tunnel',
    command: resolveBinary('rathole'),
    args: ['--client', configPath],
    env: {},
    healthCheck: () => tcpProbe(chatPort),
    restartMax: 5,
  };
}
