#!/usr/bin/env node
//
// Dev-Start gegen den gemeinsamen Remote-Dev-Stack.
//
//   node scripts/dev-remote.mjs                Vite + Electron gegen den Hetzner
//   node scripts/dev-remote.mjs --no-electron  nur Vite (Browser-Client)
//   node scripts/dev-remote.mjs --logs         Dienst-Logs des Remote-Stacks mitlesen
//   node scripts/dev-remote.mjs --origin https://…   anderes Backend
//
// Ersetzt `scripts/dev-up.fish` auf jedem Rechner, der nicht selbst den ganzen
// Stack fahren soll: es braucht nur noch Node — kein Docker, kein Postgres,
// kein uv, keine `.env` mit Zugangsdaten auf der Platte.
//
// WARUM NODE UND NICHT FISH/BASH: das hier muss auf Windows genauso laufen wie
// auf Linux. `dev-up.fish` ist fish-only, und selbst das vorhandene
// `desktop/dev` scheitert dort — es setzt die Variable in Shell-Syntax
// (`PULSE_DEV_URL=${…:-…} electron .`), die cmd und PowerShell nicht kennen.
// Node setzt die Umgebung selbst und startet die Kindprozesse direkt.
//
// ARBEITSTEILUNG: Vite läuft hier, damit HMR sofort bleibt, und leitet
// `/api/*` an das Backend weiter (`PULSE_API_ORIGIN` in web/vite.config.ts —
// der Präfix bleibt dabei stehen, weil dort nginx davorsteht). Electron lädt
// diesen lokalen Vite. Bildschirmaufnahme, Sidecars und der native Player
// bleiben ohnehin lokal, die hängen an der Hardware.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const PLAYER_BIN = WIN ? 'pulse-player.exe' : 'pulse-player';

const argv = process.argv.slice(2);

function has(flag) {
  return argv.includes(flag);
}

function valueOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const ORIGIN = valueOf('--origin', process.env.PULSE_API_ORIGIN || 'https://pulse.unicutmedia.com');
const DEV_HOST = process.env.PULSE_DEV_HOST || 'michael@77.42.71.166';
const DEV_DIR = process.env.PULSE_DEV_DIR || 'pulse-test';
const VITE_PORT = Number(process.env.PULSE_WEB_PORT || 5173);
const SERVICES = 'auth chat-gateway voice-signaling media-svc mediamtx-auth-hook';

const kids = [];
let shuttingDown = false;

/** Kindprozess starten. `shell` nur auf Windows — dort sind pnpm/electron .cmd-Wrapper. */
function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: WIN,
    ...opts,
    env: { ...process.env, ...(opts.env || {}) }
  });
  kids.push(child);
  child.on('exit', (code, signal) => {
    if (code && !signal && !shuttingDown) {
      console.error(`\n✗ ${cmd} ${args.join(' ')} endete mit Code ${code}`);
    }
  });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const kid of kids) {
    if (kid.exitCode !== null || kid.killed) continue;
    // `kill()` beendet auf Windows nur den Wrapper, nicht den Baum darunter —
    // der Vite- bzw. Electron-Prozess bliebe als Waise mit belegtem Port 5173
    // zurück. taskkill /T räumt den Baum ab und ist Bordmittel.
    if (WIN) spawn('taskkill', ['/pid', String(kid.pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    else kid.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Wartet, bis auf dem Port jemand horcht. */
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
        if (Date.now() > deadline) reject(new Error(`Port ${port} kam nicht hoch`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function printHelp() {
  console.log(
    [
      'Dev gegen den gemeinsamen Remote-Stack:',
      '  node scripts/dev-remote.mjs                Vite + Electron',
      '  node scripts/dev-remote.mjs --no-electron  nur Vite',
      '  node scripts/dev-remote.mjs --logs         Remote-Dienst-Logs mitlesen',
      '  node scripts/dev-remote.mjs --origin URL   anderes Backend',
      '',
      `Backend:  ${ORIGIN}`,
      'Code hinschieben:  scripts/dev-sync.sh [--watch]'
    ].join('\n')
  );
}

function tailRemoteLogs() {
  console.log(`→ Logs von ${DEV_HOST}:${DEV_DIR}`);
  run('ssh', [DEV_HOST, `cd '${DEV_DIR}' && docker compose logs -f --tail=50 ${SERVICES}`]);
}

/**
 * Findet die nativen Teile (Aufnahme-Sidecar, HQ-Player) und meldet, was fehlt.
 *
 * WARUM DAS HIER STEHEN MUSS: ohne diese Prüfung ist ein fehlendes Binary
 * NICHT zu erkennen — die Oberfläche blendet den HQ-Knopf einfach aus, und der
 * Knopf für das eigene Zuschauer-Fenster tut nichts. Man sucht den Fehler dann
 * im Backend, obwohl nur `scripts/hq-bauen.sh` nie gelaufen ist. `dev-up.fish`
 * warnt an dieser Stelle seit jeher; hier fehlte es und hat genau diesen
 * Irrweg ausgelöst.
 *
 * NUR LINUX BRAUCHT VARIABLEN, und zwar aus einem bestimmten Grund: Windows und
 * macOS finden ihren Sidecar über die Aufwärtssuche in
 * `desktop/electron/sidecar.ts` (`streaming/<platt>-hq-sidecar/target/…`),
 * ebenso den Player. Für den Rust-Linux-Sidecar gibt es diese Aufwärtssuche
 * NICHT — `resolveLinuxRustBinaryPath()` kennt nur `$PULSE_LINUX_HQ_SIDECAR`
 * oder den Flatpak-Pfad `/app/bin/…`. Ohne eine der beiden bleibt
 * `stream.gsrAvailable` false und der HQ-Knopf verschwindet, obwohl ein
 * gebautes Binary im Repo liegt.
 */
function resolveNativeParts() {
  const env = {};
  const report = [];
  const exists = (p) => p && fs.existsSync(p);
  const rel = (...seg) => path.join(REPO, ...seg);

  if (process.platform === 'linux') {
    // bootstrap-gsr.fish baut in den XDG-Cache; der frühere /tmp-Ort lag auf
    // tmpfs und war nach jedem Neustart weg.
    const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    const gsrCandidates = [
      path.join(cacheRoot, 'pulse/gsr/gpu-screen-recorder/build/gpu-screen-recorder'),
      '/tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder'
    ];
    const gsr = gsrCandidates.find(exists);
    if (gsr) {
      env.GSR_BINARY = gsr;
      env.PULSE_SIDECAR_PY = rel('streaming/gsr-sidecar/control.py');
    }

    const rust = rel('streaming/linux-hq-sidecar/target/release/pulse-linux-hq-sidecar');
    if (exists(rust)) {
      env.PULSE_LINUX_HQ_SIDECAR = rust;
      report.push('✓ Rust-Linux-Sidecar da (Standard-Aufnahmeweg)');
      report.push(...sidecarReport(rust));
    } else if (gsr) {
      report.push('ℹ Rust-Linux-Sidecar nicht gebaut — es läuft der GSR-Rückfall (scripts/hq-bauen.sh)');
    } else {
      report.push('⚠ Kein Aufnahme-Sidecar gebaut — der HQ-Knopf bleibt versteckt (scripts/hq-bauen.sh)');
    }
  } else {
    const sub = process.platform === 'win32' ? 'win' : 'mac';
    const exe = process.platform === 'win32' ? 'pulse-win-hq-sidecar.exe' : 'pulse-mac-hq-sidecar';
    if (!exists(rel(`streaming/${sub}-hq-sidecar/target/release/${exe}`))) {
      report.push(`⚠ HQ-Sidecar nicht gebaut — der HQ-Knopf bleibt versteckt (cargo build --release in streaming/${sub}-hq-sidecar/)`);
    }
  }

  const player = rel('streaming/pulse-player/target/release', PLAYER_BIN);
  if (!exists(player)) {
    report.push('⚠ Nativer Player nicht gebaut — "im eigenen Fenster ansehen" tut nichts, Zuschauen läuft über den Browser (scripts/hq-bauen.sh)');
  }
  return { env, report };
}

/**
 * Fragt den Sidecar SELBST nach seinem Zustand, statt am Bibliothekspfad zu
 * raten — `health` meldet dieselben Fähigkeiten, an denen auch die Oberfläche
 * ihre Schalter festmacht. So können Hinweis und App nicht auseinanderlaufen.
 *
 * DIE WICHTIGSTE ZEILE IST DIE LEERE CODEC-LISTE. Am 2026-08-18 stand hier
 * zuerst nur eine Intra-Refresh-Meldung, die auf „AMD/Intel" verwies — auf
 * einer NVIDIA-Karte. Der wahre Befund lag daneben: `video_codecs: []`, weil
 * `bootstrap-ffmpeg.sh` NVENC nur einschaltet, wenn `ffnvcodec` da ist, und
 * das Paket fehlte. Ohne Encoder taugt der Sidecar gar nichts, und die
 * Nebensache hätte den Blick weiter auf das Falsche gelenkt.
 */
function sidecarReport(binary) {
  let health;
  try {
    const out = execFileSync(binary, [], {
      input: '{"op":"health","id":1}\n',
      timeout: 30_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    health = JSON.parse(out.split('\n').find((l) => l.trim().startsWith('{')) || '{}').gsr;
  } catch {
    return ['⚠ Sidecar antwortet nicht auf `health` — HQ-Aufnahme wird nicht funktionieren'];
  }
  if (!health) return ['⚠ Sidecar liefert keinen Zustand — HQ-Aufnahme wird nicht funktionieren'];

  const lines = [];
  const codecs = health.video_codecs || [];
  if (!health.available || codecs.length === 0) {
    lines.push(
      `⚠ Sidecar hat KEINE Encoder (${health.vendor || 'unbekannt'}) — HQ-Aufnahme geht nicht. ` +
        'Auf NVIDIA fehlt meist ffnvcodec-headers; danach: PULSE_FFMPEG_NEUBAU=1 scripts/hq-bauen.sh'
    );
  } else {
    lines.push(`✓ Encoder da (${health.vendor}): ${codecs.join(', ')}`);
    if (!health.intra_refresh) {
      lines.push('ℹ Intra-Refresh nicht verfügbar — gepatchtes FFmpeg fehlt: scripts/hq-bauen.sh');
    }
  }
  return lines;
}

async function startElectron() {
  console.log('→ Electron bauen');
  const build = run('pnpm', ['run', 'build:electron'], { cwd: path.join(REPO, 'desktop') });
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) {
    console.error('✗ Electron-Build fehlgeschlagen — Vite läuft weiter, Browser tut es auch');
    return;
  }
  const { env: nativeEnv, report } = resolveNativeParts();
  for (const line of report) console.log(`  ${line}`);

  console.log('→ Electron starten');
  run('pnpm', ['run', 'start'], {
    cwd: path.join(REPO, 'desktop'),
    env: { PULSE_DEV_URL: `http://localhost:${VITE_PORT}`, PULSE_DEVTOOLS: '1', ...nativeEnv }
  });
}

async function main() {
  console.log(`→ Backend: ${ORIGIN}`);
  console.log('→ Vite starten');
  run('pnpm', ['dev'], { cwd: path.join(REPO, 'web'), env: { PULSE_API_ORIGIN: ORIGIN } });

  try {
    await waitForPort(VITE_PORT);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    shutdown();
    return;
  }
  console.log(`✓ Vite läuft auf http://127.0.0.1:${VITE_PORT}`);

  if (!has('--no-electron')) await startElectron();

  console.log(
    [
      '',
      '═══════════════════════════════════════════════',
      '  Pulse Remote-Dev läuft',
      '═══════════════════════════════════════════════',
      `  Oberfläche:   http://127.0.0.1:${VITE_PORT}   (lokal, mit HMR)`,
      `  Backend:      ${ORIGIN}   (gemeinsam)`,
      '',
      '  Backend-Änderung hinschieben:   scripts/dev-sync.sh',
      '  Dauerhaft mitziehen:            scripts/dev-sync.sh --watch',
      '  Remote-Logs:                    node scripts/dev-remote.mjs --logs',
      '  Beenden:                        Strg+C',
      ''
    ].join('\n')
  );
}

if (has('--help') || has('-h')) printHelp();
else if (has('--logs')) tailRemoteLogs();
else await main();
