#!/usr/bin/env node
//
// Dev-Start gegen den LOKALEN Stack — Windows-Port von `dev-up.fish`.
//
//   node scripts/dev-local.mjs                alles starten (Container, Dienste, Vite, Electron)
//   node scripts/dev-local.mjs --no-electron  ohne Electron (Browser-Client)
//   node scripts/dev-local.mjs --bootstrap    nur .env/Keys/Binaries erzeugen, nichts starten
//   node scripts/dev-local.mjs --down         alles stoppen (Volumes bleiben)
//   node scripts/dev-local.mjs --help
//
// Einmalig nötig: Docker Desktop (Container) und uv (Python-Dienste). Fehlt
// eines, meldet das der Pre-flight mit dem passenden Install-Befehl.
//
// WARUM DIESE Datei existiert, obwohl `dev-up.fish` den selben Stack startet:
// das fish-Skript ist an Linux gebunden — `/proc/<pid>/environ`, `ss`,
// `setsid`, fish selbst. Dasselbe Problem löst `dev-remote.mjs` schon mit Node
// statt fish/bash; hier passiert dasselbe für den lokalen Stack. Bewusst KEIN
// gemeinsames Modul: `dev-remote.mjs` ist der Arbeitsweg der anderen Rechner
// und bleibt unangetastet.
//
// WARUM LIVEKIT UND MEDIAMTX NATIV LAUFEN (kein Docker): beide Compose-Dateien
// setzen `network_mode: host` — das gibt es auf Docker Desktop für Windows
// (Linux-Container) nicht. Host-Networking war die Linux-Antwort auf zwei
// Probleme, die auf Windows wegfallen, wenn die Prozesse direkt auf dem Host
// laufen: LiveKits Webhook erreicht `127.0.0.1:8003` wieder ohne Umweg, und
// MediaMTX' auth-hook ebenfalls (`localhost:8005` — der native Prozess IST der
// Host, der Kommentar im Template gilt unverändert). Docker bleibt für das,
// was es gut kann: die drei zustandslosen Infra-Container (Postgres, Redis,
// MinIO) im Bridge-Netz.
//
//   Rollenverteilung auf Windows:
//     Docker Desktop : postgres :5434, redis :6380, minio :9000/9001
//     nativ          : livekit :7880-7892, mediamtx :1936/8889/8890/8189/9997
//     uv             : auth :8001, chat :8002, voice :8003, media :8004, hook :8005
//     node           : vite :5173, electron
//
// MEDIAMTX-VERSION: bewusst auf 1.19.1 gepinnt, NICHT auf das neueste
// Release — der Pulse-Fork (`ghcr.io/…/pulse-mediamtx:1.19.1-pulse5`, Prod)
// basiert auf 1.19.1. MediaMTX ändert gelegentlich Config-Schlüssel; gegen eine
// neuere Version kann die Vorlage hier still falsch laufen. Der native Binary
// hat die fünf Pulse-Patches NICHT (Vollbild-Rückweg, Keyframe-Takt, FlexFEC,
// Dependency-Descriptor) — für App-Entwicklung reicht er, für Messläufe zu
// diesen Features gilt: Linux-Dev-Stack oder Testserver.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { starteSelbstabgleich } from './lib/dev-selbstabgleich.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const LOCAL_DIR = path.join(REPO, '.dev-local');
const LOG_DIR = path.join(LOCAL_DIR, 'logs');
const BIN_DIR = path.join(LOCAL_DIR, 'bin');
const RUN_FILE = path.join(LOCAL_DIR, 'run.json');

const LIVEKIT_VERSION = '1.13.6';
const MEDIAMTX_VERSION = '1.19.1';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

// --- Konsolen-Farben (auch unter cmd) ----------------------------------------

const enabled = process.stdout.isTTY || process.env.FORCE_COLOR;
const grn = (s) => (enabled ? `\x1b[32m${s}\x1b[0m` : s);
const ylw = (s) => (enabled ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (enabled ? `\x1b[31m${s}\x1b[0m` : s);
const ok = (s) => console.log(grn(`✓ ${s}`));
const info = (s) => console.log(grn(`→ ${s}`));
const warn = (s) => console.log(ylw(`⚠ ${s}`));
const die = (s) => {
  console.error(red(`✗ ${s}`));
  process.exit(1);
};

// --- .env --------------------------------------------------------------------

/** Liest KEY=VALUE-Zeilen (keine Quotes — davon hat hier noch niemand Gebrauch gemacht). */
function readEnvFile(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/**
 * Erzeugt `.env` und die JWT-Schlüssel, falls sie fehlen. Beides ist
 * gitignored und maschinenlokal —Dev-Secrets, automatisch generiert statt
 * "bitte erst .env anlegen"-Abbruch. `dev-up.fish` bricht stattdessen ab;
 * auf dem eigenen Rechner ist der Komfort den Verzicht auf die Kontrolle wert.
 */
function bootstrapEnv() {
  fs.mkdirSync(path.join(REPO, 'secrets'), { recursive: true });

  if (!fs.existsSync(path.join(REPO, '.env'))) {
    const example = readEnvFile(path.join(REPO, '.env.example'));
    if (!Object.keys(example).length) die('.env fehlt und .env.example ist leer/fehlt');
    const rand = (n) => crypto.randomBytes(n).toString('hex');
    const lines = [
      '# Automatisch von scripts/dev-local.mjs erzeugt — Werte sind maschinenlokale Dev-Secrets.',
      `POSTGRES_USER=${example.POSTGRES_USER || 'dcc'}`,
      `POSTGRES_PASSWORD=${rand(16)}`,
      `POSTGRES_DB=${example.POSTGRES_DB || 'dcc'}`,
      'POSTGRES_HOST=localhost',
      '# Docker-Port-Mapping MUSS zu POSTGRES_PORT passen — die Container publishen',
      '# darauf, die Dienste (und alembic) verbinden dagegen. Die Compose-Defaults',
      '# (5433/6379) weichen davon ab, deshalb hier explizit.',
      `POSTGRES_HOST_PORT=${example.POSTGRES_PORT || '5434'}`,
      `POSTGRES_PORT=${example.POSTGRES_PORT || '5434'}`,
      `REDIS_HOST_PORT=${(example.REDIS_URL || 'redis://localhost:6380/0').match(/:(\d+)\//)?.[1] || '6380'}`,
      `REDIS_URL=${example.REDIS_URL || 'redis://localhost:6380/0'}`,
      ...Object.entries(example)
        .filter(([k]) => !['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_HOST', 'POSTGRES_PORT', 'REDIS_URL', 'INTERNAL_SERVICE_SECRET'].includes(k))
        .map(([k, v]) => `${k}=${v}`),
      `INTERNAL_SERVICE_SECRET=${crypto.randomBytes(32).toString('base64url')}`
    ];
    fs.writeFileSync(path.join(REPO, '.env'), lines.join('\n') + '\n');
    ok('.env erzeugt (Dev-Secrets frisch generiert)');
  }

  if (!fs.existsSync(path.join(REPO, 'secrets/jwt_private.pem'))) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(path.join(REPO, 'secrets/jwt_private.pem'), privateKey);
    fs.writeFileSync(path.join(REPO, 'secrets/jwt_public.pem'), publicKey);
    ok('JWT-Schlüsselpaar erzeugt (secrets/jwt_{private,public}.pem)');
  }
}

// --- Native Binaries (LiveKit, MediaMTX) --------------------------------------

function findUv() {
  const local = path.join(os.homedir(), '.local/bin', WIN ? 'uv.exe' : 'uv');
  for (const candidate of [local, 'uv']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', shell: WIN });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/**
 * docker finden — nach einer frischen Docker-Desktop-Installation ist das
 * Programm im PATH, aber LAUFENDE Shells erben das alte PATH (Windows aktualisiert
 * Umgebungsvariablen nicht rückwirkend). Deshalb der Fallback auf den
 * Standardspeicherort; `dockerCmd` statt 'docker' überall verwenden.
 */
function findDocker() {
  const candidates = WIN
    ? ['docker', 'C:/Program Files/Docker/Docker/resources/bin/docker.exe']
    : ['docker'];
  for (const candidate of candidates) {
    // Der absolute Kandidat enthält Leerzeichen ("Program Files") — unter
    // shell:true (cmd) zerreißt das den Aufruf, wenn man ihn nicht quotet.
    const quoted = WIN ? `"${candidate}"` : candidate;
    const probe = spawnSync(quoted, ['--version'], { stdio: 'ignore', shell: WIN });
    if (probe.status === 0) {
      dockerCmd = quoted;
      if (candidate.includes('/')) {
        // Die Docker-CLI exec't ihre Credential-Helper (docker-credential-*)
        // aus dem SELBEN Verzeichnis — die stehen nur im PATH, wenn er sie
        // auch enthält. Alte Shells erben das Install-PATH nicht (s.o.),
        // deshalb stellt dockerEnv() ihn jedem Aufruf voran.
        dockerBinDir = path.dirname(candidate);
      }
      return true;
    }
  }
  return false;
}

/** Umgebung für docker-Aufrufe: Docker-Bin-Verzeichnis im PATH (Credential-Helper). */
function dockerEnv() {
  if (!dockerBinDir) return process.env;
  return { ...process.env, PATH: `${dockerBinDir};${process.env.PATH}` };
}

/**
 * Lädt ein GitHub-Release-Asset herunter und entpackt es nach destDir.
 * curl statt fetch: Release-Assets zeigen auf objects.githubusercontent.com,
 * dem folgt curl selbst, und es ist auf Windows Bordmittel.
 */
function fetchReleaseZip(url, zipPath, destDir) {
  console.log(`  Download: ${url}`);
  const res = spawnSync('curl', ['-fL', '--retry', '3', '-o', zipPath, url], {
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: WIN
  });
  if (res.status !== 0) {
    console.error(res.stderr?.toString());
    die(`Download fehlgeschlagen: ${url}\n  Release-Page prüfen: https://github.com/releases`);
  }
  // tar (bsdtar von Windows) käme mit zip zurecht, das GNU-tar aus Git Bash
  // NICHT — PowerShell hat dafür Expand-Archive, das überall da ist.
  const ps = `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`;
  const unzip = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', shell: WIN });
  if (unzip.status !== 0) die(`Entpacken fehlgeschlagen: ${zipPath}`);
}

function ensureBinaries() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  // Das Release-Archiv von LiveKit nennt den Binary livekit-server (nicht livekit).
  const livekit = path.join(BIN_DIR, WIN ? 'livekit-server.exe' : 'livekit-server');
  const mediamtx = path.join(BIN_DIR, WIN ? 'mediamtx.exe' : 'mediamtx');

  if (!fs.existsSync(livekit)) {
    info(`LiveKit v${LIVEKIT_VERSION} herunterladen`);
    const zip = path.join(LOCAL_DIR, 'livekit.zip');
    fetchReleaseZip(
      `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_windows_amd64.zip`,
      zip,
      BIN_DIR
    );
    if (!fs.existsSync(livekit)) die(`livekit nicht im Archiv erwartet: ${BIN_DIR}`);
    fs.rmSync(zip, { force: true });
    ok(`LiveKit v${LIVEKIT_VERSION} bereit`);
  }

  if (!fs.existsSync(mediamtx)) {
    info(`MediaMTX v${MEDIAMTX_VERSION} herunterladen`);
    const zip = path.join(LOCAL_DIR, 'mediamtx.zip');
    fetchReleaseZip(
      `https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_windows_amd64.zip`,
      zip,
      BIN_DIR
    );
    if (!fs.existsSync(mediamtx)) die(`mediamtx nicht im Archiv erwartet: ${BIN_DIR}`);
    fs.rmSync(zip, { force: true });
    ok(`MediaMTX v${MEDIAMTX_VERSION} bereit`);
  }

  return { livekit, mediamtx };
}

// --- MediaMTX: RTMPS-Certs + Config --------------------------------------------

/** Self-signed Cert für RTMPS, wie es der Kopf von mediamtx.yml.template beschreibt. */
function ensureRtmpsCerts() {
  const certDir = path.join(REPO, 'streaming/server/certs');
  const crt = path.join(certDir, 'server.crt');
  const key = path.join(certDir, 'server.key');
  if (fs.existsSync(crt) && fs.existsSync(key)) return { crt, key, ok: true };

  fs.mkdirSync(certDir, { recursive: true });
  // openssl steckt in Git Bash; aus cmd/PowerShell ist es nicht im PATH —
  // deshalb der explizite Kandidat neben dem nackten Namen.
  const candidates = WIN ? ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'] : ['openssl'];
  for (const bin of candidates) {
    const res = spawnSync(
      bin,
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-keyout', key, '-out', crt, '-subj', '/CN=localhost'
      ],
      { stdio: 'ignore', shell: WIN }
    );
    if (res.status === 0) return { crt, key, ok: true };
  }
  warn('openssl nicht gefunden — RTMPS-Publish bleibt aus, der Rest läuft');
  return { ok: false };
}

/**
 * Erzeugt `.dev-local/mediamtx.yml` aus der Vorlage. Die Vorlage wird NICHT
 * kopiert und danach vergessen (dev-up.fish warnt vor genau diesem Drift) —
 * sie wird bei JEDEM Start neu eingelesen und nur die Windows-Unterschiede
 * werden ersetzt. Änderungen an der Vorlage greifen damit automatisch.
 */
function generateMediamtxConfig(certs) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const template = fs.readFileSync(path.join(REPO, 'streaming/server/mediamtx.yml.template'), 'utf8');
  const lan = lanIp();
  const lines = template.split(/\r?\n/).flatMap((line) => {
    // Zertifikatspfade: im Container /certs/…, nativ der echte Ort.
    if (line.startsWith('rtmpServerCert:')) return [`rtmpServerCert: ${certs.crt.replace(/\\/g, '/')}`];
    if (line.startsWith('rtmpServerKey:')) return [`rtmpServerKey: ${certs.key.replace(/\\/g, '/')}`];
    if (!certs.ok && line.startsWith('rtmpEncryption:')) return ['rtmpEncryption: no'];
    // Der Template-Kommentar dazu: lokal genügt 127.0.0.1 — außer ein ANDERES
    // Gerät (das Handy im LAN, der eigentliche Zweck des Mobile-Branchs) soll
    // zuschauen. Dann braucht es einen erreichbaren ICE-Kandidaten: die LAN-IP
    // dieses Rechners.
    if (line.trim() === '- 127.0.0.1' && lan !== '127.0.0.1') return [line, `  - ${lan}`];
    return [line];
  });
  const header = [
    '# AUTOMATISCH ERZEUGT von scripts/dev-local.mjs — NICHT bearbeiten.',
    `# Quelle: streaming/server/mediamtx.yml.template (LAN-IP ergänzt: ${lan})`,
    '# bei jedem dev-local-Start neu geschrieben.'
  ];
  lines.push(
    '',
    '# Media over QUIC — MediaMTX-Neuheit (ab 1.19), von Pulse ungenutzt. Ohne',
    '# eigenes Cert-Setting generiert er sich beim Start auto.crt/auto.key ins',
    '# Arbeitsverzeichnis und belegt Port 8892 — beides nur Müll hier.',
    'moq: no'
  );
  fs.writeFileSync(path.join(LOCAL_DIR, 'mediamtx.yml'), [...header, ...lines].join('\n') + '\n');
}

// --- Prozesse: finden, killen, detached starten ---------------------------------

/**
 * PID(s), die auf einem Port hören (TCP wie UDP).
 *
 * POWERSHELL statt netstat — und das ist keine Bequemlichkeit: netstats
 * Zustandsspalte ist LOKALISIERT (deutsches Windows: "ABHÖREN"), ein Grep auf
 * "LISTENING" findet auf deutschen Maschinen still nichts, und die ganze
 * Aufräum-Logik wird zur No-op — der Port-5173-Zombie, der den ersten
 * Stack-Start blockierte, entstand genau so. Get-NetTCPConnection/-UDPEndpoint
 * fragt den Zustand sprachunabhängig ab.
 */
function pidsListeningOn(port) {
  const ps =
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess; ` +
    `(Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`;
  const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { shell: WIN, encoding: 'utf8' });
  const pids = new Set();
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
}

function killPidTree(pid) {
  if (WIN) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true });
  else process.kill(-pid, 'SIGTERM'); // negativ = Prozessgruppe (setsid-Äquivalent)
}

/** Räumt Überbleibsel alter Läufe weg — die Windows-Version des pkill in dev-up.fish. */
function freePorts(ports) {
  for (const port of ports) {
    for (const pid of pidsListeningOn(port)) {
      if (pid === process.pid) continue;
      console.log(`  Port ${port}: alter Prozess (PID ${pid}) wird beendet`);
      killPidTree(pid);
    }
  }
}

const runState = { uvicorns: {}, livekit: null, mediamtx: null };
const UVICORN_NAMES = new Set(['auth', 'chat-gateway', 'voice-signaling', 'media-svc', 'mediamtx-auth-hook']);

function saveRunState() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify(runState, null, 2));
}

/** PIDs des letzten Laufs (welche noch leben) — für das Aufräumen vor Neustart und --down. */
function loadRunState() {
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  } catch {
    return { uvicorns: {} };
  }
}

/**
 * Detached starten: der Prozess überlebt das Skript (wie setsid+nohup im
 * fish-Original) und schreibt in eine eigene Log-Datei.
 *
 * KEIN `shell` hier (anders als bei dev-remote.mjs/pnpm): shell+detached
 * bricht unter Windows die Stdout-Umlenkung — der Prozess läuft dann still
 * und leer (leere Logs, kein Port, keine Fehlermeldung; empirisch
 * nachgestellt). Alle detached-Ziele (uv.exe, livekit-server.exe,
 * mediamtx.exe) sind echte .exe und brauchen cmd.exe nicht — die
 * .cmd-Wrapper-Problem betrifft nur pnpm/electron, die attached laufen.
 */
function startDetached(name, cmd, args, { cwd, env = {} }) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  fs.writeSync(fd, `\n── Start ${new Date().toISOString()} ──\n`);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd]
  });
  child.unref();
  if (UVICORN_NAMES.has(name)) runState.uvicorns[name] = child.pid;
  else if (name === 'livekit') runState.livekit = child.pid;
  else if (name === 'mediamtx') runState.mediamtx = child.pid;
  return child.pid;
}

/** Wartet, bis auf dem Port jemand horcht (aus dev-remote.mjs, unverändert). */
function waitForPort(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`Port ${port} kam nicht hoch (Log: .dev-local/logs/)`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** Erreichbare LAN-IP — das Handy im LAN braucht sie als Ziel. */
function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const oct = iface.address.split('.').map(Number);
        // nur private Bereiche — 169.254 (APIPA) ist "kein Netz", öffentliche
        // IPs will man nicht in ICE-Kandidaten/URLs stehen haben
        const priv =
          oct[0] === 10 ||
          (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31) ||
          (oct[0] === 192 && oct[1] === 168);
        if (priv) return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// --- Docker / Migrationen --------------------------------------------------------

async function containersUp(env) {
  info('Container starten (Postgres + Redis + MinIO)');
  // Explizite Dienstliste statt --profile voice: LiveKit läuft hier nativ, der
  // profile-gestaffelte Container aus docker-compose.yml würde nur Port-Konflikte bauen.
  const res = spawnSync(dockerCmd, ['compose', 'up', '-d', 'postgres', 'redis', 'minio', 'minio-init'], {
    cwd: REPO,
    encoding: 'utf8',
    shell: WIN,
    env: dockerEnv()
  });
  if (res.status !== 0) {
    console.error(res.stdout || '');
    console.error(res.stderr || '');
    die('docker compose fehlgeschlagen — läuft Docker Desktop?');
  }

  for (let i = 0; i < 60; i++) {
    const probe = spawnSync(
      dockerCmd,
      ['exec', 'dcc_night_postgres', 'pg_isready', '-U', env.POSTGRES_USER || 'dcc', '-d', env.POSTGRES_DB || 'dcc'],
      { stdio: 'ignore', shell: WIN, env: dockerEnv() }
    );
    if (probe.status === 0) {
      ok('Container up (Postgres healthy)');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  die('Postgres wurde nicht healthy — docker logs dcc_night_postgres ansehen');
}

function runMigrations(env) {
  if (process.env.PULSE_DEV_SKIP_MIGRATIONS === '1') {
    warn('Alembic übersprungen (PULSE_DEV_SKIP_MIGRATIONS=1)');
    return;
  }
  info('Alembic upgrade (auth + chat-gateway)');
  for (const svc of ['auth', 'chat-gateway']) {
    const res = spawnSync(
      uv, ['run', 'alembic', 'upgrade', 'head'],
      {
        cwd: path.join(REPO, 'services', svc),
        encoding: 'utf8',
        shell: WIN,
        env: {
          ...process.env,
          POSTGRES_HOST: 'localhost',
          POSTGRES_PORT: env.POSTGRES_PORT || '5434',
          POSTGRES_PASSWORD: env.POSTGRES_PASSWORD
        }
      }
    );
    if (res.status !== 0) {
      console.error((res.stderr || res.stdout || '').split('\n').slice(-15).join('\n'));
      die(`alembic ${svc} failed — DB neuer als der Branch? PULSE_DEV_SKIP_MIGRATIONS=1 überspringt das.`);
    }
  }
  ok('DB aktuell');
}

// --- Down ------------------------------------------------------------------------

function down() {
  const state = fs.existsSync(RUN_FILE) ? JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) : { uvicorns: {} };

  info('Uvicorns stoppen');
  for (const pid of Object.values(state.uvicorns || {})) killPidTree(pid);
  // plus Überbleibsel, deren run.json verloren ging
  freePorts([8001, 8002, 8003, 8004, 8005]);
  ok('Uvicorns weg');

  info('LiveKit / MediaMTX stoppen');
  for (const pid of [state.livekit, state.mediamtx].filter(Boolean)) killPidTree(pid);
  freePorts([7880, 9997]);
  ok('natives Voice/Streaming weg');

  info('Vite stoppen');
  freePorts([Number(process.env.PULSE_WEB_PORT) || 5173]);
  ok('Vite weg');

  // Electron: PULSE_DEV_URL-Instanz — das Env steckt hinter dem Wrapper-Prozess,
  // per Port geht es nicht (Electron horcht auf keinem). Best-effort über den
  // Fenster-Titel geht nicht ohne mehr Aufwand; wer Electron mit startet,
  // schließt es einfach — Strg+C räumt den Baum über den Task-Exit mit auf.
  info('Container stoppen (Postgres / Redis / MinIO)');
  if (findDocker()) {
    spawnSync(dockerCmd, ['compose', 'stop', 'postgres', 'redis', 'minio', 'minio-init'], {
      cwd: REPO,
      stdio: 'ignore',
      shell: WIN,
      env: dockerEnv()
    });
    ok('Container gestoppt (Volumes bleiben)');
  } else {
    warn('docker nicht gefunden — Container laufen weiter (Docker Desktop öffnen oder manuell stoppen)');
  }

  fs.rmSync(RUN_FILE, { force: true });
  console.log('');
  console.log(grn('═══════════════════════════════════════════════════'));
  console.log(grn('  Dev-Stack heruntergefahren'));
  console.log(grn('═══════════════════════════════════════════════════'));
  console.log('  Komplett-Reset:   docker compose down -v   (löscht Volumes!)');
  console.log('');
}

// --- Electron --------------------------------------------------------------------

function resolveNativeParts() {
  const report = [];
  const exists = (p) => p && fs.existsSync(p);
  const rel = (...seg) => path.join(REPO, ...seg);
  const sub = WIN ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const exe = WIN ? 'pulse-win-hq-sidecar.exe' : process.platform === 'darwin' ? 'pulse-mac-hq-sidecar' : 'pulse-linux-hq-sidecar';
  if (!exists(rel(`streaming/${sub}-hq-sidecar/target/release/${exe}`))) {
    report.push(`⚠ HQ-Sidecar nicht gebaut — der HQ-Knopf bleibt versteckt (cargo build --release in streaming/${sub}-hq-sidecar/)`);
  }
  const playerBin = WIN ? 'pulse-player.exe' : 'pulse-player';
  if (!exists(rel('streaming/pulse-player/target/release', playerBin))) {
    report.push('⚠ Nativer Player nicht gebaut — "im eigenen Fenster ansehen" tut nichts (scripts/hq-bauen.sh)');
  }
  return report;
}

async function startElectron(vitePort) {
  info('Electron bauen');
  const build = spawn('pnpm', ['run', 'build:electron'], { cwd: path.join(REPO, 'desktop'), stdio: 'inherit', shell: WIN });
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) {
    console.error('✗ Electron-Build fehlgeschlagen — Vite läuft weiter, Browser tut es auch');
    return;
  }
  for (const line of resolveNativeParts()) console.log(`  ${line}`);

  info('Electron starten');
  // DevTools NICHT erzwingen (gleiche Begründung wie in dev-remote.mjs):
  // PULSE_DEVTOOLS=1 vor den Aufruf setzen oder Strg+Shift+I im Fenster.
  const child = spawn('pnpm', ['run', 'start'], {
    cwd: path.join(REPO, 'desktop'),
    stdio: 'inherit',
    shell: WIN,
    env: { ...process.env, PULSE_DEV_URL: `http://localhost:${vitePort}` }
  });
  child.on('exit', () => process.exit(0));
}

// --- Hauptsache ------------------------------------------------------------------

let uv = 'uv';
let dockerCmd = 'docker';
let dockerBinDir = null;
const kids = [];
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const kid of kids) {
    if (kid.exitCode !== null || kid.killed) continue;
    // taskkill /T statt kill(): unter Windows trifft kill() nur den
    // .cmd-Wrapper, darunter bliebe Vite/Electron als Waise auf Port 5173.
    // (Gleiche Begründung wie in dev-remote.mjs.)
    if (WIN) spawn('taskkill', ['/pid', String(kid.pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    else kid.kill('SIGTERM');
  }
  // Die detached-Dienste (uvicorns, livekit, mediamtx) laufen bewusst weiter —
  // wie die Container im fish-Original. Alles aus: --down.
  setTimeout(() => process.exit(0), 300);
}

function printHelp() {
  console.log(
    [
      'Dev gegen den LOKALEN Stack (Windows-Port von dev-up.fish):',
      '  node scripts/dev-local.mjs                alles starten (Container, Dienste, Vite, Electron)',
      '  node scripts/dev-local.mjs --no-electron  ohne Electron (Browser-Client)',
      '  node scripts/dev-local.mjs --bootstrap    nur .env/Keys/Binaries erzeugen, nichts starten',
      '  node scripts/dev-local.mjs --down         alles stoppen (Volumes bleiben)',
      '',
      'Einmalig nötig: Docker Desktop + uv (Pre-flight nennt den Install-Befehl).'
    ].join('\n')
  );
}

async function main() {
  const env = readEnvFile(path.join(REPO, '.env'));

  // --- Doppelstart-Sperre ---
  // Zwei Instanzen beißen sich gegenseitig die Kinder tot: die zweite killt
  // über freePorts() die Dienste der ersten und umgekehrt, und am Ende horcht
  // ein Vite, das keiner mehr verwaltet. Deshalb: wer mit lebender scriptPid
  // ankommt, wird abgewiesen. Verstirbt die Instanz, bleibt eine tote PID
  // zurück — der nächste Start erkennt das und macht normal weiter.
  // Der alte Zustand wird HIER gelesen und durchgereicht: saveRunState()
  // überschreibt run.json sofort, und wer die LiveKit/MediaMTX-PIDs erst
  // später läse, fände nur noch die eigenen.
  const old = loadRunState();
  if (old.scriptPid) {
    try {
      process.kill(old.scriptPid, 0);
      die(`dev-local läuft bereits (PID ${old.scriptPid}) — Strg+C dort oder pnpm dev:local:down`);
    } catch {
      /* tote PID — Stale-Eintrag, wir übernehmen */
    }
  }
  runState.scriptPid = process.pid;
  saveRunState();

  // --- Pre-flight ---
  info('Pre-flight checks');
  if (!findDocker()) {
    die('docker fehlt — Docker Desktop installieren und starten:\n  winget install -e --id Docker.DockerDesktop\n  (danach einmal Rechner neu starten, falls WSL2 frisch eingerichtet wird)');
  }
  const daemon = spawnSync(dockerCmd, ['info'], { stdio: 'ignore', shell: WIN, timeout: 30_000, env: dockerEnv() });
  if (daemon.status !== 0) die('Docker-Daemon erreichbar? Docker Desktop starten, dann erneut.');

  uv = findUv();
  if (!uv) {
    die('uv fehlt — installieren mit:\n  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"');
  }
  ok('Tools da (docker, uv)');

  bootstrapEnv();
  const freshEnv = readEnvFile(path.join(REPO, '.env'));
  if (!freshEnv.POSTGRES_PASSWORD) die('POSTGRES_PASSWORD fehlt in .env');
  if (!freshEnv.INTERNAL_SERVICE_SECRET) {
    warn('INTERNAL_SERVICE_SECRET fehlt in .env — Account-Löschung (DELETE /me) bleibt 503.');
  }

  const { livekit, mediamtx } = ensureBinaries();

  // --- native Streaming-Prozesse VOR den Diensten: der auth-hook (8005) wird
  // von MediaMTX bei jeder Connection angefragt, LiveKits Webhook braucht
  // voice-signaling (8003). Erst die Zuhörer, dann die Anfrager.
  for (const pid of [old.livekit, old.mediamtx].filter(Boolean)) killPidTree(pid);
  // Port-Bereinigung auch für Überbleibsel, deren run.json-PID tot ist (bei
  // einem Crash überlebt der Server-Prozess den Wrapper und die bookkeeping-
  // PID zeigt ins Leere): LiveKit 7880/7881 (+UDP-Range via Parent), MediaMTX
  // 1936/8889/8890/8189/9997. Das sind Pulse-dev-spezifische Ports — dass hier
  // ein fremder Prozess lauscht, ist praktisch ausgeschlossen.
  freePorts([7880, 7881, 1936, 8889, 8890, 8189, 9997]);
  info('LiveKit starten (nativ, :7880)');
  startDetached('livekit', livekit, ['--config', path.join(REPO, 'infra/livekit/livekit.yaml')], { cwd: REPO });

  const certs = ensureRtmpsCerts();
  generateMediamtxConfig(certs);
  info('MediaMTX starten (nativ, :1936/:8889/:8890/:9997)');
  startDetached('mediamtx', mediamtx, [path.join(LOCAL_DIR, 'mediamtx.yml')], { cwd: REPO });

  containersUp(freshEnv);
  runMigrations(freshEnv);

  // --- Uvicorns ---
  info('Alte Dienst-Instanzen stoppen (damit --reload sauber neu startet)');
  freePorts([8001, 8002, 8003, 8004, 8005]);

  // PULSE_INSTANCE_MODE=cloud: lokales Dev verhält sich wie howispulse.com.
  // Ohne das greift der Default `self-host` → chat-gateway crasht beim Start
  // und auth-svc blockt POST /register. (Begründung ausführlich in dev-up.fish.)
  const commonEnv = {
    REDIS_URL: freshEnv.REDIS_URL || 'redis://localhost:6380/0',
    AUTH_JWKS_URL: 'http://127.0.0.1:8001/.well-known/jwks.json',
    PULSE_INSTANCE_MODE: 'cloud'
  };
  const uploadEnv = {
    // Permissive Upload-Defaults fürs Dev (siehe Kommentar in dev-up.fish —
    // ohne diese Zeilen wären Ablage und DM-Anhänge tot).
    CLOUD_DM_ATTACHMENTS_ENABLED: 'true',
    CLOUD_DROPBOX_ENABLED: 'true',
    CLOUD_ATTACHMENT_MIME_PREFIXES: ''
  };
  const pgEnv = {
    POSTGRES_PASSWORD: freshEnv.POSTGRES_PASSWORD,
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: freshEnv.POSTGRES_PORT || '5434'
  };
  const jwtEnv = {
    JWT_PRIVATE_KEY_FILE: path.join(REPO, 'secrets/jwt_private.pem'),
    JWT_PUBLIC_KEY_FILE: path.join(REPO, 'secrets/jwt_public.pem')
  };
  const internalEnv = { INTERNAL_SERVICE_SECRET: freshEnv.INTERNAL_SERVICE_SECRET || '' };
  // LIVEKIT_URL bewusst localhost, NICHT die LAN-IP: voice-signaling
  // verweigert den Start mit den Repo-Dev-Keys gegen eine Nicht-lokale URL
  // (`_enforce_secret_guards` — öffentlich bekannte Keys + erreichbarer Server
  // = jeder könnte Voice-Tokens minten). Desktop-Dev läuft damit genauso wie
  // unter dev-up.fish; Voice vom HANDY im LAN bräuchte echte API-Keys.
  const lkEnv = {
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecretdevsecretdevsecretdevsecret',
    LIVEKIT_URL: 'ws://localhost:7880'
  };

  const services = [
    ['auth', 'dcc_auth.app:app', ['--port', '8001'], {
      ...pgEnv, ...jwtEnv, ...commonEnv, ...internalEnv,
      CHAT_GATEWAY_URL: 'http://127.0.0.1:8002'
    }],
    ['chat-gateway', 'dcc_chat_gateway.app:app', ['--port', '8002', '--ws-max-size', '65536'], {
      ...pgEnv, ...commonEnv, ...internalEnv, ...uploadEnv,
      MEDIA_SVC_URL: 'http://127.0.0.1:8004'
    }],
    ['voice-signaling', 'dcc_voice_signaling.app:app', ['--port', '8003'], {
      ...commonEnv, ...lkEnv, ...internalEnv,
      CHAT_GATEWAY_URL: 'http://127.0.0.1:8002'
    }],
    ['media-svc', 'dcc_media_svc.app:app', ['--port', '8004'], {
      ...commonEnv,
      MEDIAMTX_API_URL: 'http://127.0.0.1:9997/v3/paths/list'
    }],
    ['mediamtx-auth-hook', 'dcc_mediamtx_auth_hook.app:app', ['--port', '8005'], { ...commonEnv }]
  ];

  runState.uvicorns = {};
  info('Uvicorns starten (mit --reload)');
  for (const [name, app, extra, svcEnv] of services) {
    const pid = startDetached(
      name, uv,
      ['run', 'uvicorn', app, '--host', '127.0.0.1', ...extra, '--reload'],
      { cwd: path.join(REPO, 'services', name), env: svcEnv }
    );
    console.log(`  ${name}: PID ${pid}`);
  }
  saveRunState();

  for (const port of [8001, 8002, 8003, 8004, 8005]) {
    try {
      // 5 Minuten: beim ALLERERSTEN Start resolutioniert uv den Workspace,
      // lädt CPython und alle Wheels — das kann je nach Leitung dauern.
      await waitForPort(port, 300_000);
    } catch (err) {
      console.error(`✗ ${err.message}`);
      die(`${port} kam nicht hoch — Log ansehen: .dev-local/logs/`);
    }
  }
  ok('Services up (auth/chat/voice/media/auth-hook)');

  // --- Vite ---
  const vitePort = Number(process.env.PULSE_WEB_PORT) || 5173;
  // Auch den Port freimachen: ein Zombie-Vite hier würde waitForPort unten
  // fälschlich zufriedenstellen und die Oberfläche bliebe tot.
  freePorts([vitePort]);
  info('Vite starten');
  // KEIN PULSE_API_ORIGIN setzen (und eine geerbte Variable entfernen!): ohne
  // die proxied Vite per Default auf die lokalen Dienste — das ist genau der
  // lokale Modus (web/vite.config.ts, apiProxy()). PULSE_WEB_HOST=0.0.0.0
  // macht die Oberfläche im LAN erreichbar (Handy-Test) — die Config-Default
  // 127.0.0.1 bleibt sonst bestehen, CLI --host gewinnt.
  const { PULSE_API_ORIGIN, ...inherited } = process.env;
  const webHost = process.env.PULSE_WEB_HOST;
  const viteArgs = webHost ? ['dev', '--host', webHost] : ['dev'];
  const vite = spawn('pnpm', viteArgs, {
    cwd: path.join(REPO, 'web'),
    stdio: 'inherit',
    shell: WIN,
    env: { ...inherited, PULSE_WEB_PORT: String(vitePort) }
  });
  kids.push(vite);
  // Stirbt Vite (Crash, Port-Konflikt), endet dieses Skript — die detached
  // Dienste laufen weiter. Der Hinweis muss her, sonst sucht man das Beenden
  // an der falschen Stelle.
  vite.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`\nVite endete (Code ${code ?? 'Signal'}) — Dienste laufen weiter. Alles aus: pnpm dev:local:down`);
    shutdown();
  });
  try {
    await waitForPort(vitePort);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    shutdown();
    return;
  }
  ok(`Vite läuft auf http://127.0.0.1:${vitePort}`);

  if (!has('--no-electron')) await startElectron(vitePort);

  // Dauerhaft an: gleiche Logik wie dev-remote.mjs — gepushte Commits werden
  // selbst nachgezogen (nur bei sauberem Arbeitsbaum). Aus: PULSE_DEV_PULL=0.
  if (process.env.PULSE_DEV_PULL !== '0') {
    starteSelbstabgleich({ repo: REPO, log: (zeile) => console.log(zeile) });
  }

  const lan = lanIp();
  console.log(
    [
      '',
      '═══════════════════════════════════════════════',
      '  Pulse Lokal-Dev läuft',
      '═══════════════════════════════════════════════',
      `  Oberfläche:   http://127.0.0.1:${vitePort}   (lokal, mit HMR)`,
      `  Backend:      lokal — auth :8001, chat :8002, voice :8003, media :8004, hook :8005`,
      `  Infra:        postgres :${pgEnv.POSTGRES_PORT}  redis :6380  minio :9000  livekit :7880  mediamtx :8889`,
      '',
      `  Handy im LAN: PULSE_WEB_HOST=0.0.0.0 setzen, dann http://${lan}:${vitePort} vom Handy`,
      '                (Streaming klappt vom Handy; Voice bräuchte echte LiveKit-Keys — Dev-Keys gelten nur lokal)',
      '  Logs:         .dev-local/logs/',
      '  Beenden:      Strg+C  (Vite/Electron) — Dienste laufen weiter',
      '  Alles aus:    pnpm dev:local:down',
      ''
    ].join('\n')
  );
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (has('--help') || has('-h')) printHelp();
else if (has('--down')) down();
else if (has('--bootstrap')) {
  // Erster Lauf auf neuem Rechner, oder bewusst vorab: alles Herunterladbare
  // und Generierbare erledigen, ohne den Stack zu starten.
  info('Bootstrap: .env, JWT-Keys, Binaries, MediaMTX-Config');
  bootstrapEnv();
  ensureBinaries();
  generateMediamtxConfig(ensureRtmpsCerts());
  ok('Bootstrap fertig — starten mit: node scripts/dev-local.mjs');
} else await main();
