import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderContainerEnv, hostLanIpv4s } from '../../electron/localBackend/containerBackendManager.ts';
import { runtimeCandidates, inFlatpak, machineAction } from '../../electron/localBackend/containerRuntime.ts';
import type { BootstrapCreds } from '../../electron/localBackend/pairing.ts';

const CREDS: BootstrapCreds = {
  instanceId: '123', ownerId: '7', hostname: 'app-123.relay.howispulse.com',
  clientId: 'cid', clientSecret: 'SECRET', cloudOrigin: 'https://howispulse.com',
  relaySubdomain: 'brave-otter-4f2a.relay.howispulse.com',
  relayServerAddr: 'howispulse.com:7000', relayTunnelToken: 'plse_relay_x',
};

test('renderContainerEnv: Relay-Instanz → behind-proxy + Relay-Vars + Subdomain als Hostname', () => {
  const env = renderContainerEnv(CREDS);
  assert.match(env, /^PULSE_HOSTNAME=brave-otter-4f2a\.relay\.howispulse\.com$/m);
  assert.match(env, /^PULSE_TLS_MODE=behind-proxy$/m);
  assert.match(env, /^PULSE_RELAY_SUBDOMAIN=brave-otter-4f2a\.relay\.howispulse\.com$/m);
  assert.match(env, /^PULSE_RELAY_SERVER_ADDR=howispulse\.com:7000$/m);
  assert.match(env, /^PULSE_RELAY_TUNNEL_TOKEN=plse_relay_x$/m);
  assert.match(env, /^PULSE_CLOUD_CLIENT_SECRET=SECRET$/m);
  assert.match(env, /^PULSE_INSTANCE_ID=123$/m);
  assert.match(env, /^PULSE_INSTANCE_OWNER_ID=7$/m);
});

test('renderContainerEnv: ohne Relay-Felder keine PULSE_RELAY_-Zeilen, Hostname = creds.hostname', () => {
  const env = renderContainerEnv({
    ...CREDS, relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null,
  });
  assert.equal(env.includes('PULSE_RELAY_'), false);
  assert.match(env, /^PULSE_HOSTNAME=app-123\.relay\.howispulse\.com$/m);
});

test('renderContainerEnv: PULSE_HOST_ORIGIN=app_host immer gesetzt (mit und ohne Relay)', () => {
  assert.match(renderContainerEnv(CREDS), /^PULSE_HOST_ORIGIN=app_host$/m);
  assert.match(
    renderContainerEnv({ ...CREDS, relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null }),
    /^PULSE_HOST_ORIGIN=app_host$/m,
  );
});

test('renderContainerEnv: partielle Relay-Creds → KEINE Relay-Zeilen (nie leere Strings)', () => {
  // Erkennungsmuster im Image ist FEHLENDE Variablen — ein leerer String
  // gälte als "Relay konfiguriert" und würde frpc ins Leere starten lassen.
  const env = renderContainerEnv({ ...CREDS, relayTunnelToken: null });
  assert.equal(env.includes('PULSE_RELAY_'), false);
  assert.equal(/^\w+=$/m.test(env), false); // keine Zeile mit leerem Wert
});

test('renderContainerEnv: adminEmail-Override und Platzhalter', () => {
  assert.match(renderContainerEnv(CREDS, 'ich@example.org'), /^PULSE_ADMIN_EMAIL=ich@example\.org$/m);
  assert.match(renderContainerEnv(CREDS), /^PULSE_ADMIN_EMAIL=admin@brave-otter-4f2a\.relay\.howispulse\.com$/m);
});

test('renderContainerEnv: LAN-IPs → PULSE_DIRECT_EXTRA_HOST_IPS; ohne → Variable fehlt', () => {
  const env = renderContainerEnv(CREDS, undefined, ['192.168.178.42', '10.0.0.9']);
  assert.match(env, /^PULSE_DIRECT_EXTRA_HOST_IPS=192\.168\.178\.42,10\.0\.0\.9$/m);
  // Leere Liste → Variable komplett weglassen (leerer String gälte im
  // Adapter als "konfiguriert, aber kaputt").
  assert.equal(renderContainerEnv(CREDS).includes('PULSE_DIRECT_EXTRA_HOST_IPS'), false);
});

test('hostLanIpv4s: filtert internal/IPv6/link-local/WSL-NAT, dedupliziert', () => {
  const ips = hostLanIpv4s({
    Ethernet: [
      { family: 'IPv4', address: '192.168.178.42', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    WLAN: [{ family: 'IPv4', address: '192.168.178.42', internal: false }], // Duplikat
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.80.1', internal: false }],
    APIPA: [{ family: 'IPv4', address: '169.254.10.5', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Leer: undefined,
  });
  assert.deepEqual(ips, ['192.168.178.42']);
});

test('machineAction: inspect-Ergebnis → init/start/none', () => {
  assert.equal(machineAction(125, ''), 'init');                                  // keine Machine
  assert.equal(machineAction(0, 'kein json'), 'init');                           // kaputte Ausgabe
  assert.equal(machineAction(0, JSON.stringify([{ State: 'stopped' }])), 'start');
  assert.equal(machineAction(0, JSON.stringify([{ State: 'Running' }])), 'none'); // case-tolerant
});

test('runtimeCandidates: Flatpak → flatpak-spawn --host, sonst podman vor docker', () => {
  if (process.platform === 'linux') {
    const fp = runtimeCandidates({ FLATPAK_ID: 'com.howispulse.Pulse' });
    assert.deepEqual(fp[0].argv, ['flatpak-spawn', '--host', 'podman']);
    assert.equal(fp[0].viaFlatpak, true);
  }
  const plain = runtimeCandidates({});
  const kinds = plain.map((c) => c.kind);
  assert.ok(kinds.indexOf('podman') < kinds.indexOf('docker'));
  assert.equal(inFlatpak({}), existsSync('/.flatpak-info'));
});
