/**
 * Bausteine rund um `run` des allinone-Containers (aus
 * containerBackendManager.ts herausgezogen, Größen-Policy): Härtung,
 * Klartext-Fehler, Image-IDs für den Update-Rückweg, Aufräumen verwaister
 * Geheimnis-Dateien. Keine Electron-Imports (node:test-tauglich).
 */

import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { rtExec, type ContainerRuntime } from './containerRuntime.ts';
import {
  DIREKT_MUX, HOST_HTTP_PORT, LIVEKIT_TCP, LIVEKIT_UDP, RTMPS, UDP_GATEWAY_PORT, WHEP_ICE,
  UDP_MEDIA_PORTS, macTcpPortArgs, mediaPortArgs,
} from './medienPorts.ts';
import { pullMitWegwerfLogin, raeumeVerwaisteAuth } from './registryAuth.ts';
import { updateVerdict } from './containerEnv.ts';
import type { BootstrapCreds } from './pairing.ts';
import { vmIpAusIpAusgabe } from './hostNetz.ts';
import { waitFor } from './health.ts';
import { containerName, datenVolume } from './containerWelt.ts';
import { probeGateway, startUdpGatewayRelay, type UdpGatewayRelay } from './udpGateway.ts';
import { UDP_GATEWAY_SNIPPET } from './udpGatewaySnippet.ts';
import { DOCKER_KEIN_RECHT } from './runtimeWahl.ts';

/** Container-Härtung, NUR Linux. Am echten Image nachgemessen (2026-10-08,
 *  `pulse-allinone:edge` f174b8c3990d, rootless Podman 5): Erststart mit
 *  initdb, `stop -t 20` (sauber, exit 0), Recreate auf demselben Volume und
 *  `exec du` — alle gesund, dieselbe Prozessliste wie ohne Härtung, kein
 *  EPERM im Log. Die Liste ist die, die s6-overlay und die Init-Skripte
 *  brauchen: CHOWN/FOWNER/DAC_OVERRIDE (01-init-data-dirs, Postgres-Datadir),
 *  SETUID/SETGID (Dienste laufen als `pulse`), KILL (s6 beendet Dienste
 *  anderer UIDs), NET_BIND_SERVICE (Caddy). Docker (rootful) ist NICHT
 *  eigens gemessen — seine Vorgabe ist eine Obermenge derselben Fähigkeiten.
 *  Win/Mac (podman machine) bleiben unberührt, dort ist nichts gemessen. */
export function haertungArgs(plattform: NodeJS.Platform = process.platform): string[] {
  if (plattform !== 'linux') return [];
  return [
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN,SETUID,SETGID,DAC_OVERRIDE,FOWNER,KILL,NET_BIND_SERVICE',
  ];
}

/** Netzwerk-Argumente für `run`, je Betriebsart:
 *  - **Windows** (podman machine/WSL2, `hostNet`): `--network host`, weil
 *    rootless Podman in der WSL-VM eingehendes UDP NICHT über published Ports
 *    in den Container leitet (TCP schon). Der Container bindet direkt auf der
 *    VM-Host-IP; die Host-Relays (ensureRelay) tragen die Pakete vom
 *    Windows-Host in die VM.
 *  - **macOS** (gvproxy, applehv): die VM-IP ist vom Host aus nicht
 *    erreichbar (E2E 2026-09-28), host-net mündete in „VM-IP nicht
 *    ermittelbar". Deshalb Publish — aber UDP kommt über gvproxy nie an,
 *    also nur TCP plus der Gateway-Port (127.0.0.1); die UDP-Medien reicht
 *    das Host-Gateway-Relay durch (udpGateway.ts).
 *  - **Linux**: klassischer Publish (nativer NAT). */
export function netzArgs(hostNet: boolean, plattform: NodeJS.Platform = process.platform): string[] {
  if (hostNet) return ['--network', 'host'];
  const http = ['-p', `127.0.0.1:${HOST_HTTP_PORT}:8080`];
  if (plattform === 'darwin') {
    return [...http, ...macTcpPortArgs(), '-p', `127.0.0.1:${UDP_GATEWAY_PORT}:${UDP_GATEWAY_PORT}/tcp`];
  }
  return [...http, ...mediaPortArgs()];
}

function portZweck(port: number): string | null {
  if (port === RTMPS) return 'Bildschirmübertragung des Betreibers (RTMPS)';
  if (port === LIVEKIT_TCP || LIVEKIT_UDP.includes(port)) return 'Sprachkanäle';
  if (port === WHEP_ICE) return 'Stream-Wiedergabe';
  if (port === DIREKT_MUX) return 'Direktverbindung';
  return null;
}

const PORT_BELEGT = /port is already allocated|address already in use|bind: address/i;
const PORT_BELEGT_ABHILFE = 'ein anderes Programm oder ein zweiter Server nutzt ihn. Beende es und starte den Server erneut.';

/** Port aus der Konflikt-Zeile: die letzte `:<zahl>` davor — deckt
 *  Docker („Bind for 0.0.0.0:1936 failed: port is already allocated") wie
 *  Podman/rootlessport („listen udp4 :8189: bind: address already in use"). */
export function belegterPort(stderr: string): number | null {
  const zeile = stderr.split('\n').find((z) => PORT_BELEGT.test(z));
  if (!zeile) return null;
  const vorKonflikt = zeile.slice(0, zeile.search(PORT_BELEGT));
  const treffer = [...vorKonflikt.matchAll(/:(\d{2,5})(?!\d)/g)];
  const port = treffer.length ? Number(treffer[treffer.length - 1][1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** Fehler eines gescheiterten `run` — die `message` geht so in die
 *  Oberfläche. Erkannte Fälle in Klartext, sonst wie bisher roh. */
export function runFehler(code: number, stderr: string): Error {
  if (PORT_BELEGT.test(stderr)) {
    const port = belegterPort(stderr);
    if (port === null) {
      return new Error(`Ein Port, den der Server braucht, ist auf diesem Rechner schon belegt — ${PORT_BELEGT_ABHILFE}`);
    }
    const zweck = portZweck(port);
    const wofuer = zweck ? ` (gebraucht für: ${zweck})` : '';
    return new Error(`Port ${port} ist auf diesem Rechner schon belegt${wofuer} — ${PORT_BELEGT_ABHILFE}`);
  }
  if (/permission denied/i.test(stderr) && /docker\.sock|docker daemon/i.test(stderr)) {
    return new Error(DOCKER_KEIN_RECHT);
  }
  return new Error(`container start failed (exit ${code}): ${stderr.slice(0, 400)}`);
}

/** IP der podman-machine-VM — Ziel der Host-Relays (nur Windows/WSL2).
 *  null auf Linux/Docker/macOS oder wenn die Abfrage scheitert (fail-soft:
 *  kein Relay). macOS seit 2026-09-28 bewusst AUS: applehv-Maschinen netzen
 *  gvproxy-seitig (VM-IP vom Host aus unerreichbar, s. netzArgs), der
 *  Container publiziert seine Ports direkt — ein Relay aufs Nichts
 *  kollidierte sogar mit gvproxy auf 1936. Ausgabe ganz parsen statt ein
 *  Interface festzunageln: WSL2 heißt es eth0, Podman 6/applehv enp0s1
 *  (E2E 2026-09-28). */
export async function machineVmIp(
  rt: ContainerRuntime,
  plattform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (rt.kind !== 'podman' || plattform !== 'win32') return null;
  const r = await rtExec(rt, ['machine', 'ssh', 'ip -4 addr show'], { timeoutMs: 20_000 }).catch(() => null);
  return r?.code === 0 ? vmIpAusIpAusgabe(r.stdout) : null;
}

/** Container (neu) anlegen: alten entfernen (Recreate statt Restart → nimmt
 *  frisch gepullte Images + Env-Änderungen mit; /data lebt im Named Volume),
 *  Env-Datei schreiben, `run`, Env-Datei löschen.
 *
 *  Die Env-Datei (0600) ist die einzige Stelle mit Klartext-Secrets auf der
 *  Platte und lebt NUR für `run`: die Runtime legt die Werte in der
 *  Container-Konfiguration ab, auch `--restart unless-stopped` liest sie
 *  nicht erneut. Bis 2026-10-08 entstand sie VOR dem bis zu 15 min langen
 *  Pull und blieb bei App-Ende im Pull liegen; jetzt erst hier. Vorher
 *  löschen: `mode` greift nur beim Anlegen. Windows ignoriert `mode`, dort
 *  schützt allein das Benutzerprofil. */
export async function legeContainerAn(
  rt: ContainerRuntime,
  o: { envFile: string; envInhalt: string; netArgs: string[]; image: string },
): Promise<void> {
  await rtExec(rt, ['rm', '-f', containerName()], { timeoutMs: 60_000 });
  rmSync(o.envFile, { force: true });
  writeFileSync(o.envFile, o.envInhalt, { encoding: 'utf8', mode: 0o600 });
  const run = await rtExec(rt, [
    'run', '-d',
    '--name', containerName(),
    '--restart', 'unless-stopped',
    '--env-file', o.envFile,
    '-v', `${datenVolume()}:/data`,
    ...haertungArgs(),
    ...o.netArgs,
    o.image,
  ], { timeoutMs: 120_000 }).finally(() => rmSync(o.envFile, { force: true }));
  if (run.code !== 0) throw runFehler(run.code, run.stderr);
}

/** Image-ID eines Containers, oder null (gibt es nicht / Abfrage scheitert). */
export async function imageIdVon(rt: ContainerRuntime, container: string): Promise<string | null> {
  const r = await rtExec(rt, ['inspect', container, '--format', '{{.Image}}'], { timeoutMs: 15_000 }).catch(() => null);
  const id = r?.code === 0 ? r.stdout.trim() : '';
  return id || null;
}

/** Update-Check im Betrieb: Image pullen (Login gegen eine Wegwerf-
 *  Anmeldedatei, registryAuth.ts) und die Image-ID des laufenden Containers
 *  mit der des frisch gepullten Images vergleichen. Jeder Fehler (offline,
 *  Registry down, Container weg) → 'none' — nächster Versuch beim nächsten
 *  Intervall, kein Alarm. */
export async function pruefeImageUpdate(
  rt: ContainerRuntime,
  image: string,
  creds: BootstrapCreds,
  basisVerzeichnis: string,
): Promise<'update' | 'none'> {
  const pull = await pullMitWegwerfLogin({
    rt, image, benutzer: creds.clientId, passwort: creds.clientSecret, basisVerzeichnis,
  }).catch(() => null);
  if (!pull?.ok) return 'none';
  const running = await imageIdVon(rt, containerName());
  const pulled = await rtExec(rt, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15_000 })
    .catch(() => null);
  if (!running || pulled?.code !== 0) return 'none';
  return updateVerdict(running, pulled.stdout);
}

/** Daten-Volume löschen (nur nach removeContainer — sonst "volume in use").
 *  true bei Erfolg; ein bereits fehlendes Volume zählt als Erfolg. */
export async function entferneDatenVolume(rt: ContainerRuntime): Promise<boolean> {
  const exists = await rtExec(rt, ['volume', 'inspect', datenVolume()], { timeoutMs: 15_000 }).catch(() => null);
  if (exists?.code !== 0) return true; // schon weg — nichts zu tun
  const r = await rtExec(rt, ['volume', 'rm', datenVolume()], { timeoutMs: 60_000 }).catch(() => null);
  return r?.code === 0;
}

/** Docker prefixt IDs mit `sha256:`, Podman nicht. */
export function gleicheImageId(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/^sha256:/, '');
  return norm(a) === norm(b);
}

/** Abgelöstes Image entfernen — ohne `-f`: hängt noch ein Container einer
 *  anderen Benutzer-Welt daran, lehnt die Runtime ab, und das ist richtig. */
export async function entferneImage(rt: ContainerRuntime, id: string): Promise<void> {
  await rtExec(rt, ['image', 'rm', id], { timeoutMs: 60_000 }).catch(() => null);
}

/** Geheimnis-Reste aus abgebrochenen Läufen unter `userData` löschen: die
 *  `container.env` (lebt regulär nur für die Dauer von `run`) und die
 *  Wegwerf-Anmeldedateien (regulär nur für die Dauer des Pulls) — in JEDER
 *  Benutzer-Welt (`pulse-host*`). Best-effort. */
export function raeumeVerwaistes(userData: string): void {
  let namen: string[];
  try { namen = readdirSync(userData); } catch { return; }
  for (const n of namen) {
    if (!n.startsWith('pulse-host')) continue;
    const dir = join(userData, n);
    try { rmSync(join(dir, 'container.env'), { force: true }); } catch { /* best-effort */ }
    raeumeVerwaisteAuth(dir);
  }
}

/** macOS: UDP-Medien-Ports am Host binden und per TCP-Frames durch das
 *  Container-Gateway reichen (gvproxy leitet UDP nicht). Gateway fehlt
 *  (altes Image) → einmalig per `exec -d` nachstarten. */
export async function starteMacGateway(
  rt: ContainerRuntime,
  progress: (step: string) => void,
): Promise<UdpGatewayRelay> {
  const gwHost = '127.0.0.1';
  if (!(await probeGateway(gwHost, UDP_GATEWAY_PORT))) {
    progress('gateway');
    const exec = await rtExec(
      rt,
      ['exec', '-d', containerName(), '/opt/pulse/venv/bin/python3', '-c', UDP_GATEWAY_SNIPPET],
      { timeoutMs: 30_000 },
    );
    if (exec.code !== 0) {
      throw new Error(`udp-gateway exec fehlgeschlagen: ${exec.stderr.slice(0, 300)}`);
    }
    const ok = await waitFor(() => probeGateway(gwHost, UDP_GATEWAY_PORT), 20_000, 1_000).catch(() => false);
    if (!ok) throw new Error('udp-gateway im Container nicht erreichbar');
  }
  return startUdpGatewayRelay(UDP_MEDIA_PORTS, gwHost, UDP_GATEWAY_PORT, (msg) => console.log(msg));
}
