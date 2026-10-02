import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderContainerEnv, hostLanIpv4s, vmIpAusIpAusgabe, RELAY_UDP_PORTS } from '../../electron/localBackend/containerBackendManager.ts';
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

test('renderContainerEnv: vmAnnounceIp → PULSE_VM_ANNOUNCE_IP; ohne → Variable fehlt', () => {
  const env = renderContainerEnv(CREDS, undefined, ['192.168.178.42'], '192.168.178.42');
  assert.match(env, /^PULSE_VM_ANNOUNCE_IP=192\.168\.178\.42$/m);
  // Nur im Win/VM-Betrieb gesetzt (Linux-App-Host: STUN/srflx läuft bewusst).
  assert.equal(renderContainerEnv(CREDS, undefined, ['192.168.178.42']).includes('PULSE_VM_ANNOUNCE_IP'), false);
});

test('RELAY_UDP_PORTS: Voice-/WHEP-ICE komplett gespiegelt (Win-VM-Lücke 2026-10-01)', () => {
  for (let p = 7882; p <= 7892; p++) assert.ok(RELAY_UDP_PORTS.includes(p), `LiveKit-ICE ${p} fehlt`);
  assert.ok(RELAY_UDP_PORTS.includes(7900), 'Direktpfad-Mux 7900 fehlt');
  assert.ok(RELAY_UDP_PORTS.includes(8189), 'WHEP-ICE 8189 fehlt');
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

test('vmIpAusIpAusgabe: erste globale IPv4, Loopback übersprungen — Interface-Name egal', () => {
  // Podman 6 / applehv auf macOS (E2E 2026-09-28): enp0s1, kein eth0.
  const mac = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536',
    '    inet 127.0.0.1/8 scope host lo',
    '2: enp0s1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500',
    '    inet 192.168.127.2/24 brd 192.168.127.255 scope global dynamic',
  ].join('\n');
  assert.equal(vmIpAusIpAusgabe(mac), '192.168.127.2');
  // WSL2-Stand (Windows, bisheriger Fix-stand): eth0.
  const wsl = '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP>\n    inet 172.20.144.5/20 brd 172.20.159.255';
  assert.equal(vmIpAusIpAusgabe(wsl), '172.20.144.5');
  // WSL2 mit DNS-Tunneling (echte Ausgabe, Windows-E2E 2026-10-01): auf `lo`
  // liegt VOR eth0 eine zweite, GLOBALE Pseudo-Adresse (10.255.255.254) —
  // die darf nicht gewinnen, sonst laufen Health-Poll/Relay ins Leere.
  const wslDnsTunnel = [
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000',
    '    inet 127.0.0.1/8 scope host lo',
    '       valid_lft forever preferred_lft forever',
    '    inet 10.255.255.254/32 brd 10.255.255.254 scope global lo',
    '       valid_lft forever preferred_lft forever',
    '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000',
    '    inet 172.20.162.222/20 brd 172.20.175.255 scope global eth0',
  ].join('\n');
  assert.equal(vmIpAusIpAusgabe(wslDnsTunnel), '172.20.162.222');
  // Nur Loopback (VM ohne Netz) → null, kein Relay.
  assert.equal(vmIpAusIpAusgabe('1: lo:\n    inet 127.0.0.1/8'), null);
  assert.equal(vmIpAusIpAusgabe(''), null);
});

// Benutzer-Welten: Namen schalten um, Legacy bleibt suffix-los

import { setzeContainerWelt, containerName, datenVolume } from '../../electron/localBackend/containerBackendManager.ts';

test('Benutzer-Welten: Suffix nur bei gesetzter Welt, Legacy bleibt nacktl', () => {
  setzeContainerWelt(null);
  assert.equal(containerName(), 'pulse-host');
  assert.equal(datenVolume(), 'pulse-host-data');
  setzeContainerWelt('u123');
  assert.equal(containerName(), 'pulse-host-u123');
  assert.equal(datenVolume(), 'pulse-host-data-u123');
  setzeContainerWelt(null); // aufräumen für andere Tests
});
