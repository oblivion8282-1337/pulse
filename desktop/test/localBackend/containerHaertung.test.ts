import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { infoAuswerten, waehleRuntime, type Kandidat } from '../../electron/localBackend/runtimeWahl.ts';
import { authArgv, dockerZielAusInspect, pullMitWegwerfLogin } from '../../electron/localBackend/registryAuth.ts';
import {
  belegterPort, gleicheImageId, haertungArgs, netzArgs, raeumeVerwaistes, runFehler,
} from '../../electron/localBackend/containerLauf.ts';
import {
  MEDIA_MAP_TCP, MEDIA_MAP_UDP, RTMPS, TURN, UDP_MEDIA_PORTS, macTcpPortArgs, mediaPortArgs,
} from '../../electron/localBackend/medienPorts.ts';
import { renderContainerEnv, udpGatewayAusFuer } from '../../electron/localBackend/containerEnv.ts';
import { hostLanIpv4s } from '../../electron/localBackend/hostNetz.ts';
import { rtExecToFile, type ContainerRuntime } from '../../electron/localBackend/containerRuntime.ts';
import type { BootstrapCreds } from '../../electron/localBackend/pairing.ts';

const ohneShell = process.platform === 'win32';
const podman: ContainerRuntime = { kind: 'podman', argv: ['podman'], viaFlatpak: false };
const docker: ContainerRuntime = { kind: 'docker', argv: ['docker'], viaFlatpak: false };
const bereit = { status: 'bereit' } as const;
const stumm = (grund: string) => ({ status: 'kein-zugriff', grund }) as const;

// ── Runtime-Probe ───────────────────────────────────────────────────────────

test('infoAuswerten: Docker ohne Gruppenrecht, Dienst aus, Podman ohne subuid, Frist, Erfolg', () => {
  assert.deepEqual(infoAuswerten('docker', { code: 0, stderr: '' }), { status: 'bereit' });
  const recht = infoAuswerten('docker', {
    code: 1,
    stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
  });
  assert.equal(recht.status, 'kein-zugriff');
  assert.match(recht.status === 'kein-zugriff' ? recht.grund : '', /usermod -aG docker/);
  const aus = infoAuswerten('docker', {
    code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  });
  assert.match(aus.status === 'kein-zugriff' ? aus.grund : '', /Docker-Dienst läuft nicht/);
  const subuid = infoAuswerten('podman', {
    code: 125, stderr: 'Error: cannot find UID/GID for user michael: no subuid ranges found for user "michael" in /etc/subuid',
  });
  assert.match(subuid.status === 'kein-zugriff' ? subuid.grund : '', /Unter-IDs/);
  const frist = infoAuswerten('podman', { code: -1, stderr: '' });
  assert.match(frist.status === 'kein-zugriff' ? frist.grund : '', /antwortet aber nicht/);
});

// ── Runtime-Wahl ────────────────────────────────────────────────────────────

const k = (rt: ContainerRuntime, probe: Kandidat['probe'], bestand?: boolean): Kandidat => ({ rt, probe, bestand });

test('waehleRuntime: gemerkte Runtime gewinnt, auch wenn Podman davor steht', () => {
  const w = waehleRuntime([k(podman, bereit), k(docker, bereit)], 'docker');
  assert.equal(w.rt?.kind, 'docker');
  assert.equal(w.ausBestand, false);
});

test('waehleRuntime: gemerkte Runtime stumm → KEINE, nicht die andere (sonst leerer Server)', () => {
  const w = waehleRuntime([k(podman, bereit), k(docker, stumm('Docker-Dienst aus.'))], 'docker');
  assert.equal(w.rt, null);
  assert.match(w.problem ?? '', /mit Docker angelegt.*Docker-Dienst aus/);
  const weg = waehleRuntime([k(podman, bereit), k(docker, { status: 'fehlt' })], 'docker');
  assert.equal(weg.rt, null);
  assert.match(weg.problem ?? '', /nicht \(mehr\) installiert/);
});

test('waehleRuntime: ohne Merkung zählt Bestand (Docker-Server, Podman kam dazu)', () => {
  const w = waehleRuntime([k(podman, bereit, false), k(docker, bereit, true)], null);
  assert.equal(w.rt?.kind, 'docker');
  assert.equal(w.ausBestand, true);
});

test('waehleRuntime: ohne Merkung und Bestand → alter Stand, Podman zuerst', () => {
  assert.equal(waehleRuntime([k(podman, bereit), k(docker, bereit)], null).rt?.kind, 'podman');
  // Neuer Rechner: stummes Docker hält den Start NICHT auf.
  assert.equal(waehleRuntime([k(podman, bereit), k(docker, stumm('x'))], null, false).rt?.kind, 'podman');
});

test('waehleRuntime: Bestandsrechner + stumme Runtime + bereite ohne Bestand → anhalten', () => {
  const w = waehleRuntime([k(podman, bereit, false), k(docker, stumm('Docker-Dienst aus.'))], null, true);
  assert.equal(w.rt, null);
  assert.match(w.problem ?? '', /lief schon ein Pulse-Server.*Docker-Dienst aus/);
  // Hat die bereite den Bestand, ist alles klar.
  assert.equal(waehleRuntime([k(podman, bereit, true), k(docker, stumm('x'))], null, true).rt?.kind, 'podman');
});

test('waehleRuntime: nichts bereit → Grund der ersten stummen; nichts installiert → kein Grund', () => {
  assert.equal(waehleRuntime([k(podman, { status: 'fehlt' }), k(docker, stumm('G'))], null).problem, 'G');
  assert.equal(waehleRuntime([k(podman, { status: 'fehlt' }), k(docker, { status: 'fehlt' })], null).problem, null);
});

// ── Docker-Kontext bei der Wegwerf-Anmeldung ────────────────────────────────

test('dockerZielAusInspect: Vorgabe-Kontext, rootless, TLS-Kontext, Unsinn', () => {
  const vorgabe = '[{"Name":"default","Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock","SkipTLSVerify":false}},'
    + '"TLSMaterial":{},"Storage":{"MetadataPath":"\\u003cIN MEMORY\\u003e","TLSPath":"\\u003cIN MEMORY\\u003e"}}]';
  assert.deepEqual(dockerZielAusInspect(vorgabe), ['-H', 'unix:///var/run/docker.sock']);
  const rootless = '[{"Name":"rootless","Endpoints":{"docker":{"Host":"unix:///run/user/1000/docker.sock"}},"TLSMaterial":{}}]';
  assert.deepEqual(dockerZielAusInspect(rootless), ['-H', 'unix:///run/user/1000/docker.sock']);
  const tls = JSON.stringify([{
    Name: 'fern', Endpoints: { docker: { Host: 'tcp://10.0.0.5:2376', SkipTLSVerify: false } },
    TLSMaterial: { docker: ['ca.pem', 'cert.pem', 'key.pem'] },
    Storage: { TLSPath: '/home/u/.docker/contexts/tls/abc' },
  }]);
  assert.deepEqual(dockerZielAusInspect(tls), [
    '-H', 'tcp://10.0.0.5:2376', '--tlsverify',
    '--tlscacert', '/home/u/.docker/contexts/tls/abc/docker/ca.pem',
    '--tlscert', '/home/u/.docker/contexts/tls/abc/docker/cert.pem',
    '--tlskey', '/home/u/.docker/contexts/tls/abc/docker/key.pem',
  ]);
  assert.deepEqual(dockerZielAusInspect('kein json'), []);
  assert.deepEqual(dockerZielAusInspect('[]'), []);
});

test('authArgv: Docker-Ziel steht hinter --config und vor dem Unterbefehl, Podman unberührt', () => {
  assert.deepEqual(authArgv('docker', '/d', ['pull', 'img'], ['-H', 'unix:///x']), ['--config', '/d', '-H', 'unix:///x', 'pull', 'img']);
  assert.deepEqual(authArgv('podman', '/d', ['pull', 'img'], ['-H', 'egal']), ['pull', '--authfile', '/d/auth.json', 'img']);
});

test('pullMitWegwerfLogin: Docker-Login und -Pull gehen an den aktiven Kontext', { skip: ohneShell }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pulse-ctx-'));
  const log = join(tmp, 'aufrufe.log');
  const skript = join(tmp, 'docker.sh');
  writeFileSync(skript, [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    'if [ "$1" = context ]; then echo \'[{"Endpoints":{"docker":{"Host":"unix:///run/user/1000/docker.sock"}}}]\'; fi',
    'cat >/dev/null',
    'exit 0',
  ].join('\n'));
  const rt: ContainerRuntime = { kind: 'docker', argv: ['sh', skript], viaFlatpak: false };
  const r = await pullMitWegwerfLogin({
    rt, image: 'registry.example.com/x:edge', benutzer: 'cid', passwort: 'geheim', basisVerzeichnis: join(tmp, 'welt'),
  });
  assert.equal(r.ok, true);
  const zeilen = readFileSync(log, 'utf8').trim().split('\n');
  const login = zeilen.find((z) => z.includes(' login '));
  const pull = zeilen.find((z) => z.includes(' pull '));
  assert.match(login ?? '', /^--config \S+ -H unix:\/\/\/run\/user\/1000\/docker\.sock login registry\.example\.com/);
  assert.match(pull ?? '', /^--config \S+ -H unix:\/\/\/run\/user\/1000\/docker\.sock pull /);
  assert.equal(zeilen.some((z) => z.includes('geheim')), false, 'Passwort nie im argv');
});

// ── run-Fehler in Klartext ──────────────────────────────────────────────────

test('belegterPort/runFehler: Docker- und Podman-Wortlaut, Socket-Recht, Unbekanntes', () => {
  const dockerTxt = 'docker: Error response from daemon: driver failed programming external connectivity on endpoint pulse-host: '
    + 'Bind for 0.0.0.0:1936 failed: port is already allocated.';
  assert.equal(belegterPort(dockerTxt), 1936);
  assert.match(runFehler(125, dockerTxt).message, /^Port 1936 ist auf diesem Rechner schon belegt \(gebraucht für: Bildschirmübertragung/);
  const podmanTxt = 'Error: rootlessport listen udp 0.0.0.0:8189: bind: address already in use';
  assert.equal(belegterPort(podmanTxt), 8189);
  assert.match(runFehler(126, podmanTxt).message, /^Port 8189 ist .*Stream-Wiedergabe/);
  assert.equal(belegterPort('cannot listen on the UDP port: listen udp4 :7885: bind: address already in use'), 7885);
  assert.match(runFehler(1, 'address already in use').message, /^Ein Port, den der Server braucht/);
  assert.match(
    runFehler(1, 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock').message,
    /usermod -aG docker/,
  );
  assert.match(runFehler(125, 'irgendwas').message, /^container start failed \(exit 125\): irgendwas/);
});

test('gleicheImageId: Docker-Präfix egal', () => {
  assert.equal(gleicheImageId('sha256:abc\n', 'abc'), true);
  assert.equal(gleicheImageId('abc', 'abd'), false);
});

// ── Härtung + Netz ──────────────────────────────────────────────────────────

test('haertungArgs: nur Linux, mit gemessener Fähigkeiten-Liste', () => {
  const a = haertungArgs('linux');
  assert.deepEqual(a.slice(0, 4), ['--security-opt', 'no-new-privileges', '--cap-drop', 'ALL']);
  assert.equal(a[5], 'CHOWN,SETUID,SETGID,DAC_OVERRIDE,FOWNER,KILL,NET_BIND_SERVICE');
  assert.deepEqual(haertungArgs('darwin'), []);
  assert.deepEqual(haertungArgs('win32'), []);
});

test('RTMPS nur Loopback, TURN nirgends veröffentlicht oder gemappt', () => {
  for (const args of [mediaPortArgs(), macTcpPortArgs(), netzArgs(false, 'linux'), netzArgs(false, 'darwin')]) {
    const pubs = args.filter((_, i) => args[i - 1] === '-p');
    assert.ok(pubs.includes(`127.0.0.1:${RTMPS}:${RTMPS}/tcp`), `RTMPS-Loopback fehlt in ${pubs.join(' ')}`);
    assert.equal(pubs.some((p) => p.includes(String(TURN))), false, `TURN in ${pubs.join(' ')}`);
    assert.equal(pubs.some((p) => p === `${RTMPS}:${RTMPS}/tcp` || p.startsWith(`0.0.0.0:${RTMPS}`)), false);
  }
  assert.equal(MEDIA_MAP_TCP.includes(RTMPS), false);
  assert.equal(MEDIA_MAP_UDP.includes(TURN), false);
  assert.equal(UDP_MEDIA_PORTS.includes(TURN), false);
  assert.deepEqual(netzArgs(true, 'win32'), ['--network', 'host']);
});

test('UDP-Gateway aus auf allen Plattformen ausser macOS', () => {
  assert.equal(udpGatewayAusFuer('linux'), true);
  assert.equal(udpGatewayAusFuer('win32'), true);
  assert.equal(udpGatewayAusFuer('darwin'), false);
  const creds = {
    instanceId: '1', ownerId: '2', hostname: 'a.example.com', clientId: 'c', clientSecret: 's',
    cloudOrigin: 'https://x', relaySubdomain: null, relayServerAddr: null, relayTunnelToken: null,
  } as BootstrapCreds;
  assert.match(renderContainerEnv(creds, undefined, [], undefined, udpGatewayAusFuer('linux')), /^PULSE_UDP_GATEWAY_DISABLED=true$/m);
});

test('hostLanIpv4s: cni0, lxcbr0, lxdbr0, incusbr0, waydroid0, podman0, virbr1 sind virtuell', () => {
  const v4 = (address: string) => [{ family: 'IPv4', address, internal: false, netmask: '255.255.255.0' }];
  const ips = hostLanIpv4s({
    eth0: v4('192.168.178.20'),
    cni0: v4('10.88.0.1'),
    lxcbr0: v4('10.0.3.1'),
    lxdbr0: v4('10.10.10.1'),
    incusbr0: v4('10.20.0.1'),
    waydroid0: v4('192.168.240.1'),
    podman0: v4('10.89.0.1'),
    virbr1: v4('192.168.100.1'),
  });
  assert.deepEqual(ips, ['192.168.178.20']);
});

// ── Geheimnis-Dateien ───────────────────────────────────────────────────────

test('raeumeVerwaistes: Env-Datei und Wegwerf-Anmeldungen jeder Welt weg, Rest bleibt', () => {
  const ud = mkdtempSync(join(tmpdir(), 'pulse-ud-'));
  for (const welt of ['pulse-host', 'pulse-host-u7']) {
    mkdirSync(join(ud, welt, 'registry-auth-abc'), { recursive: true });
    writeFileSync(join(ud, welt, 'registry-auth-abc', 'auth.json'), '{}');
    writeFileSync(join(ud, welt, 'container.env'), 'PULSE_CLOUD_CLIENT_SECRET=x\n');
    writeFileSync(join(ud, welt, 'bleibt.txt'), '');
  }
  writeFileSync(join(ud, 'pulse-host.json'), '{}'); // Datei mit passendem Präfix: kein Absturz
  raeumeVerwaistes(ud);
  for (const welt of ['pulse-host', 'pulse-host-u7']) {
    assert.equal(existsSync(join(ud, welt, 'container.env')), false);
    assert.equal(existsSync(join(ud, welt, 'registry-auth-abc')), false);
    assert.equal(existsSync(join(ud, welt, 'bleibt.txt')), true);
  }
  assert.equal(existsSync(join(ud, 'pulse-host.json')), true);
});

test('rtExecToFile: Export-Datei 0600, auch wenn sie vorher 0644 existierte', { skip: ohneShell }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pulse-exp-'));
  const neu = join(tmp, 'neu.tar');
  const alt = join(tmp, 'alt.tar');
  writeFileSync(alt, 'alt');
  chmodSync(alt, 0o644);
  for (const ziel of [neu, alt]) {
    const r = await rtExecToFile({ argv: ['printf'] }, ['geheim'], ziel);
    assert.equal(r.code, 0);
    assert.equal(statSync(ziel).mode & 0o777, 0o600, ziel);
    assert.equal(readFileSync(ziel, 'utf8'), 'geheim');
  }
});
