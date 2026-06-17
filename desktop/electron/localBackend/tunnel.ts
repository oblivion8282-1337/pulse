// rathole client config (TOML). Der Relay-Server kennt denselben Service-Namen
// + Token und exponiert ihn unter der Subdomain (TLS terminiert am Relay).

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
