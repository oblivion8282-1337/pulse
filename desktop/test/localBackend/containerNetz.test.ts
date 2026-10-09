/**
 * Container-Weg, Netz-Seite (Scan 2026-10-08): Host-IP-Auswahl, Default-
 * Route, gemeinsame Portlisten, Relay-Lebenszyklus, Grenzen, WSL-Install-
 * Auswertung, Wegwerf-Registry-Anmeldung.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostLanIpv4s, istMirrored, imSubnetz } from '../../electron/localBackend/hostNetz.ts';
import { parseGateway } from '../../electron/localBackend/gateway.ts';
import {
  MEDIA_MAP_TCP, RELAY_TCP_PORTS, mediaPortArgs, macTcpPortArgs, LIVEKIT_TCP,
} from '../../electron/localBackend/medienPorts.ts';
import { RelaySteuerung, type RelayZiel } from '../../electron/localBackend/relaySteuerung.ts';
import { NeuePeerBremse, lruEinfuegen, beruehre } from '../../electron/localBackend/relayGrenzen.ts';
import {
  wslInstallAuswerten, WSL_ABGEBROCHEN, WSL_NEUSTART, WSL_INSTALL_SKRIPT,
} from '../../electron/localBackend/containerRuntime.ts';
import { authArgv } from '../../electron/localBackend/registryAuth.ts';
import { renderContainerEnv } from '../../electron/localBackend/containerBackendManager.ts';
import type { BootstrapCreds } from '../../electron/localBackend/pairing.ts';

const v4 = (address: string, netmask = '255.255.255.0') => ({ family: 'IPv4', address, internal: false, netmask });

// ── hostNetz ────────────────────────────────────────────────────────────────

test('hostLanIpv4s: Adapter im Subnetz des Default-Gateways steht vorn', () => {
  const ifaces = {
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    'LAN-Verbindung* 10': [v4('192.168.137.1')],
    Tailscale: [v4('100.101.102.103', '255.255.255.255')],
    WLAN: [v4('192.168.178.42')],
  };
  const ips = hostLanIpv4s(ifaces, { gateway: '192.168.178.1' });
  assert.equal(ips[0], '192.168.178.42');
  // Nachrangige bleiben dabei, aber hinten.
  assert.deepEqual(new Set(ips), new Set(['192.168.178.42', '192.168.56.1', '192.168.137.1', '100.101.102.103']));
});

test('hostLanIpv4s: echtes 172.16/12-LAN bleibt, WSL-NAT fliegt über die VM-IP raus', () => {
  const ifaces = {
    Ethernet: [v4('172.20.1.50', '255.255.0.0')],
    'Hyper-V-Netz': [v4('192.168.200.1', '255.255.240.0')], // WSL-NAT im 192.168er-Bereich
  };
  const ips = hostLanIpv4s(ifaces, { gateway: '172.20.0.1', vmIp: '192.168.200.7' });
  assert.deepEqual(ips, ['172.20.1.50']);
});

test('hostLanIpv4s: Mirrored — die VM-IP IST die Host-Adresse und bleibt', () => {
  const ifaces = { WLAN: [v4('192.168.178.42')] };
  assert.deepEqual(hostLanIpv4s(ifaces, { vmIp: '192.168.178.42' }), ['192.168.178.42']);
});

test('hostLanIpv4s: virtuelle Brücken (docker0/vEthernet WSL) per Name raus, APIPA raus', () => {
  const ifaces = {
    docker0: [v4('172.17.0.1', '255.255.0.0')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.28.80.1', '255.255.240.0')],
    Ethernet: [v4('169.254.3.4', '255.255.0.0'), v4('10.0.0.5')],
  };
  assert.deepEqual(hostLanIpv4s(ifaces), ['10.0.0.5']);
});

test('istMirrored / imSubnetz', () => {
  assert.equal(istMirrored('192.168.178.42', { WLAN: [v4('192.168.178.42')] }), true);
  assert.equal(istMirrored('172.20.144.5', { WLAN: [v4('192.168.178.42')] }), false);
  assert.equal(imSubnetz('172.20.144.1', '255.255.240.0', '172.20.150.9'), true);
  assert.equal(imSubnetz('172.20.144.1', undefined, '172.20.150.9'), false);
});

// ── gateway ─────────────────────────────────────────────────────────────────

test('parseGateway win32: kleinste Metrik gewinnt, nicht die erste Zeile', () => {
  const out = [
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '          0.0.0.0          0.0.0.0     192.168.137.1   192.168.137.5     55',
    '          0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.50     25',
  ].join('\n');
  assert.equal(parseGateway('win32', out), '192.168.0.1');
});

test('parseGateway linux: kleinste Metrik bei mehreren Default-Routen', () => {
  const out = 'default via 10.0.0.1 dev wlan0 metric 600\ndefault via 192.168.1.1 dev eth0 metric 100\n';
  assert.equal(parseGateway('linux', out), '192.168.1.1');
});

// ── medienPorts ─────────────────────────────────────────────────────────────

test('LiveKit-TCP 7881: im Linux-Publish, im mac-Publish, im Win-Relay auf 0.0.0.0', () => {
  assert.ok(mediaPortArgs().includes(`${LIVEKIT_TCP}:${LIVEKIT_TCP}/tcp`));
  assert.ok(macTcpPortArgs().includes(`0.0.0.0:${LIVEKIT_TCP}:${LIVEKIT_TCP}/tcp`));
  assert.deepEqual(RELAY_TCP_PORTS.find((p) => p.port === LIVEKIT_TCP)?.bind, '0.0.0.0');
  assert.ok(MEDIA_MAP_TCP.includes(LIVEKIT_TCP));
});

test('RTMPS 1936 bleibt im Win-Relay 127.0.0.1-only', () => {
  assert.deepEqual(RELAY_TCP_PORTS.find((p) => p.port === 1936)?.bind, '127.0.0.1');
});

// ── relaySteuerung ──────────────────────────────────────────────────────────

function fakeStarter(udpPorts: number[] = [7900]) {
  const offen: { art: string; ip: string; zu: boolean }[] = [];
  let udpAufrufe = 0;
  return {
    offen,
    get udpAufrufe() { return udpAufrufe; },
    starter: {
      udp: async (ip: string) => {
        udpAufrufe += 1;
        await new Promise((r) => setTimeout(r, 5));
        const e = { art: 'udp', ip, zu: false };
        offen.push(e);
        return { boundPorts: udpPorts, close: () => { e.zu = true; } };
      },
      tcp: async (ip: string) => {
        const e = { art: 'tcp', ip, zu: false };
        offen.push(e);
        return { boundPorts: [1936], close: () => { e.zu = true; } };
      },
    },
  };
}
const ziel = (vmIp: string, mirrored = false): (() => Promise<RelayZiel>) =>
  async () => ({ vmIp, bindIps: ['192.168.178.42'], mirrored });

test('RelaySteuerung: überlappende Aufrufe starten nur EIN Relay (Single-Flight)', async () => {
  const f = fakeStarter();
  const r = new RelaySteuerung(f.starter, () => {});
  await Promise.all([r.abgleichen(ziel('172.20.0.5')), r.abgleichen(ziel('172.20.0.5'))]);
  assert.equal(f.udpAufrufe, 1);
  assert.deepEqual(r.zustand().udpPorts, [7900]);
});

test('RelaySteuerung: neue VM-IP → alte Relays zu, neue gegen die neue Adresse', async () => {
  const f = fakeStarter();
  const r = new RelaySteuerung(f.starter, () => {});
  await r.abgleichen(ziel('172.20.0.5'));
  await r.abgleichen(ziel('172.20.0.5')); // gleiches Ziel → nichts neu
  assert.equal(f.udpAufrufe, 1);
  await r.abgleichen(ziel('172.31.9.9'));
  assert.equal(f.udpAufrufe, 2);
  assert.ok(f.offen.filter((e) => e.ip === '172.20.0.5').every((e) => e.zu));
  assert.ok(f.offen.filter((e) => e.ip === '172.31.9.9').every((e) => !e.zu));
  assert.equal(r.zustand().vmIp, '172.31.9.9');
});

test('RelaySteuerung: 0 gebundene Ports = kein Relay, nächster Abgleich versucht neu', async () => {
  const f = fakeStarter([]);
  const r = new RelaySteuerung(f.starter, () => {});
  await r.abgleichen(ziel('172.20.0.5'));
  assert.deepEqual(r.zustand().udpPorts, []);
  await r.abgleichen(ziel('172.20.0.5'));
  assert.equal(f.udpAufrufe, 2);
  assert.ok(f.offen.filter((e) => e.art === 'udp').every((e) => e.zu));
});

test('RelaySteuerung: Mirrored → keine Relays, Flag in zustand()', async () => {
  const f = fakeStarter();
  const r = new RelaySteuerung(f.starter, () => {});
  await r.abgleichen(ziel('192.168.178.42', true));
  assert.equal(f.udpAufrufe, 0);
  assert.equal(r.zustand().mirrored, true);
});

test('RelaySteuerung: close() während des Starts → Ergebnis verworfen, nichts verwaist', async () => {
  const f = fakeStarter();
  const r = new RelaySteuerung(f.starter, () => {});
  const lauf = r.abgleichen(ziel('172.20.0.5'));
  await new Promise((res) => setTimeout(res, 1));
  r.close();
  await lauf;
  assert.ok(f.offen.every((e) => e.zu), 'nach close() darf kein Relay offen bleiben');
  assert.deepEqual(r.zustand().udpPorts, []);
});

// ── relayGrenzen ────────────────────────────────────────────────────────────

test('NeuePeerBremse: je IP und Fenster begrenzt, neues Fenster gibt frei', () => {
  const b = new NeuePeerBremse(2, 1000);
  assert.equal(b.erlaube('10.0.0.1', 0), true);
  assert.equal(b.erlaube('10.0.0.1', 10), true);
  assert.equal(b.erlaube('10.0.0.1', 20), false);
  assert.equal(b.erlaube('10.0.0.2', 20), true); // andere IP unberührt
  assert.equal(b.erlaube('10.0.0.1', 1000), true);
});

test('lruEinfuegen: volle Map verdrängt den am längsten unbenutzten', () => {
  const m = new Map<string, number>();
  lruEinfuegen(m, 'a', 1, 2);
  lruEinfuegen(m, 'b', 2, 2);
  beruehre(m, 'a', 1); // a zuletzt benutzt → b ist der älteste
  assert.equal(lruEinfuegen(m, 'c', 3, 2), 2);
  assert.deepEqual([...m.keys()], ['a', 'c']);
});

// ── containerRuntime: WSL-Install ───────────────────────────────────────────

test('wslInstallAuswerten: Abbruch, Fehler, Erfolg, Neustart nötig', () => {
  assert.deepEqual(wslInstallAuswerten(WSL_ABGEBROCHEN, false), { ok: false, neustartNoetig: false, abgebrochen: true });
  assert.equal(wslInstallAuswerten(1, false).ok, false);
  assert.deepEqual(wslInstallAuswerten(0, true), { ok: true, neustartNoetig: false, abgebrochen: false });
  assert.equal(wslInstallAuswerten(0, false).neustartNoetig, true);
  assert.equal(wslInstallAuswerten(WSL_NEUSTART, true).neustartNoetig, true);
});

test('WSL_INSTALL_SKRIPT: abgebrochene UAC endet NICHT als exit $null (=0)', () => {
  assert.match(WSL_INSTALL_SKRIPT, /\$ErrorActionPreference = 'Stop'/);
  assert.match(WSL_INSTALL_SKRIPT, new RegExp(`catch \\{ exit ${WSL_ABGEBROCHEN} \\}`));
  assert.match(WSL_INSTALL_SKRIPT, /\$null -eq \$p/);
});

// ── registryAuth ────────────────────────────────────────────────────────────

test('authArgv: podman --authfile am Unterbefehl, docker --config global', () => {
  assert.deepEqual(authArgv('podman', '/x', ['login', 'reg', '-u', 'u']), ['login', '--authfile', '/x/auth.json', 'reg', '-u', 'u']);
  assert.deepEqual(authArgv('podman', '/x', ['pull', 'img']), ['pull', '--authfile', '/x/auth.json', 'img']);
  assert.deepEqual(authArgv('docker', '/x', ['pull', 'img']), ['--config', '/x', 'pull', 'img']);
});

// ── Env: UDP-Gateway unter Windows aus ──────────────────────────────────────

test('renderContainerEnv: udpGatewayAus → PULSE_UDP_GATEWAY_DISABLED=true, sonst fehlt die Zeile', () => {
  const c: BootstrapCreds = {
    instanceId: '1', ownerId: '2', hostname: 'h', clientId: 'c', clientSecret: 's',
    cloudOrigin: 'https://x', relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null,
  };
  assert.match(renderContainerEnv(c, undefined, [], undefined, true), /^PULSE_UDP_GATEWAY_DISABLED=true$/m);
  assert.equal(renderContainerEnv(c).includes('PULSE_UDP_GATEWAY_DISABLED'), false);
});
