/**
 * Persistent log for the desktop sidecar — a diagnosable paper trail when a
 * stream silently fails to go live.
 *
 * The {@link SidecarManager} spawns whichever sidecar binary the platform
 * needs (Rust on Linux/Windows/macOS, the Python GSR sidecar only as the Linux
 * fallback) and all of them speak the same newline-JSON protocol on stdio.
 * This module captures that traffic — `stdout` (the JSON-RPC events/responses:
 * state transitions, fps, health, error messages; fps is thinned out, see
 * `sidecar-log-noise.ts` for why) and `stderr` (Rust panics / anyhow chains /
 * Python tracebacks — and, decisive for GPU cases, FFmpeg's own av_log lines,
 * which surface nowhere else) — plus lifecycle markers (spawn / exit / error),
 * each line timestamped and tagged `[out]` / `[err]` / `[lifecycle]`.
 *
 * It is the single chokepoint for ALL GPU vendors: on Windows the same Rust
 * sidecar runs the NVIDIA (NVENC), AMD (D3D12VA/AMF) and Intel/CPU paths —
 * every one of them logs here, so one `sidecar.log` covers every card.
 *
 * Location: ``<userData>/sidecar.log`` (on Windows
 * ``%APPDATA%\Pulse\sidecar.log``), beside the existing ``updater.log``.
 * Bounded by rotation: once the file passes {@link MAX_BYTES} it is renamed to
 * ``sidecar.log.old`` and a fresh file starts (keeps ~one back-file → ≤ ~4 MB
 * total). Everything is best-effort — logging must never break the sidecar.
 *
 * Secret hygiene (project rule: never log stream tokens): anything that looks
 * like a token/password in a query string or JSON field is masked before write.
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

import { createDrossel } from './sidecar-log-drossel';
import { createNoiseFilter } from './sidecar-log-noise';

const FILE = 'sidecar.log';
const OLD_FILE = 'sidecar.log.old';
/** Rotate the active log once it exceeds this — keeps one `.old` back-file. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Secret-bearing patterns redacted from every logged line. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(token=)[^&"\s]+/gi, '$1<redacted>'],
  [/(pass=)[^&"\s]+/gi, '$1<redacted>'],
  [/("token"\s*:\s*")[^"]+/gi, '$1<redacted>"'],
  [/("push_?url"\s*:\s*")[^"]+/gi, '$1<redacted>"']
];

function redact(line: string): string {
  let out = line;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** fps-Ausdünnung (Begründung + Testbarkeit: `sidecar-log-noise.ts`). */
const suppressAsNoise = createNoiseFilter();

let cachedPath: string | null = null;
function logPath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = join(app.getPath('userData'), FILE);
  return cachedPath;
}

/**
 * Mitgeführte Dateigröße, damit nicht JEDE Zeile den Datenträger befragt.
 *
 * Vorher rief `rotateIfNeeded` je Zeile `existsSync` UND `statSync` — zusammen
 * mit dem `appendFileSync` waren das drei synchrone Dateisystem-Zugriffe pro
 * Protokollzeile, alle auf dem Electron-Hauptfaden. Bei der FFmpeg-Fehlerflut
 * vom 2026-08-07 (rund 4400 Zeilen je Sekunde) sind das über 13 000 Zugriffe je
 * Sekunde auf dem Faden, der auch die Oberfläche und die Fenster bedient.
 *
 * `null` = noch unbekannt, dann einmal nachsehen. Danach wird nur noch
 * mitgezählt; ein Zählfehler kostet höchstens eine etwas zu späte Rotation.
 */
let groesse: number | null = null;

function rotateIfNeeded(zusatz: number): void {
  try {
    if (groesse === null) {
      groesse = existsSync(logPath()) ? statSync(logPath()).size : 0;
    }
    if (groesse + zusatz < MAX_BYTES) {
      groesse += zusatz;
      return;
    }
    renameSync(logPath(), join(app.getPath('userData'), OLD_FILE));
    groesse = zusatz;
  } catch {
    /* best-effort — a failed rotation must not stop logging */
    // Größe verwerfen: nach einem Fehlschlag stimmt der mitgeführte Wert
    // womöglich nicht mehr, und einmal nachsehen ist billiger als eine
    // Rotation, die nie wieder auslöst.
    groesse = null;
  }
}

/**
 * Deckel gegen Protokollfluten (s. `sidecar-log-drossel.ts`). Bewusst EINER für
 * alle Ströme: die Kosten entstehen am Datenträger und am Hauptfaden, also dort,
 * wo alle zusammenlaufen.
 */
const drossel = createDrossel();

/**
 * Append one sidecar output line. `stream` tags the source (`out` / `err` /
 * `lifecycle`); empty lines are dropped. All errors are swallowed so a
 * misbehaving filesystem can never take the sidecar down with it.
 */
export function logSidecar(stream: 'out' | 'err' | 'lifecycle', line: string): void {
  const text = (line ?? '').trimEnd();
  if (!text.trim()) return;
  const now = Date.now();
  if (suppressAsNoise(stream, text, now)) return;
  // Überlastschutz NACH der Rausch-Politik: die dünnt gezielt aus (fps), die
  // Drossel wehrt nur Fluten ab. Umgekehrt verbrauchten fps-Zeilen Vorrat, den
  // im Fehlerfall die Fehlermeldungen brauchen.
  if (!drossel.darf(now)) return;
  const nachtrag = drossel.nachtrag(now);
  try {
    if (nachtrag) schreiben('lifecycle', nachtrag);
    schreiben(stream, redact(text));
  } catch {
    /* best-effort */
  }
}

function schreiben(stream: string, text: string): void {
  const zeile = `${new Date().toISOString()} [${stream}] ${text}\n`;
  rotateIfNeeded(Buffer.byteLength(zeile, 'utf8'));
  appendFileSync(logPath(), zeile, 'utf8');
}
