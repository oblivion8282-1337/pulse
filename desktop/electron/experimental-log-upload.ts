/**
 * Diagnose-Log-Upload des Sidecars.
 *
 * Lädt bei Stream-Ende (und bei einem Stream-Fehler) die `sidecar.log` +
 * etwas Systeminfo an den Server hoch — ABER nur bei ausdrücklichem Opt-in
 * (`uploadDiagnosticLogs`-Store-Key, default aus; Schalter im
 * Kompatibilitäts-Tab).
 *
 * Der Opt-in hing früher am `useRustSidecar`-Toggle: solange Rust die bewusst
 * gewählte Ausnahme war, WAR dieser Toggle die Einwilligung. Seit Rust der
 * Standard ist, trägt er sie nicht mehr — sonst lüde jeder Linux-Nutzer
 * ungefragt Logs hoch. Daher ein eigener Schalter.
 *
 * Der Log ist bereits token-redacted (der Sidecar redacted vor dem Loggen,
 * `sidecar-log.ts` redacted beim Tee nochmals). Wir laden nur den Schwanz der
 * Datei hoch; der Server-Endpoint (`POST /experimental-logs`, auth-Service)
 * begrenzt zusätzlich und ist rate-limited.
 *
 * Endpoint überschreibbar via `$PULSE_EXPERIMENTAL_LOG_URL` (Dev/Test).
 */

import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import { app } from 'electron';

import { logSidecar } from './sidecar-log';
import { storeGet } from './store';

const ENDPOINT =
  process.env.PULSE_EXPERIMENTAL_LOG_URL ?? 'https://howispulse.com/api/experimental-logs';

/** Muss zum Server-`MAX_LOG_CHARS` (routes_experimental_logs.py) passen. */
const MAX_LOG_BYTES = 512 * 1024;

/** Pro Slot: kam seit dem letzten Start ein `error`-Event? → bestimmt `reason`. */
const sawError = new Map<number, boolean>();

/**
 * Im `gsr:event`-Handler aufrufen. Sammelt `error`-Zustand und triggert beim
 * `stopped`-Event den Upload — no-op ohne Opt-in.
 */
export function onSidecarEventForUpload(ev: { ev?: string }, slot: number): void {
  if (ev.ev === 'error') {
    sawError.set(slot, true);
    return;
  }
  if (ev.ev !== 'stopped') return;

  const reason = sawError.get(slot) ? 'error' : 'stream_end';
  sawError.delete(slot);

  // Nur mit ausdrücklichem Opt-in (default aus).
  if (storeGet('uploadDiagnosticLogs') !== true) return;

  void uploadExperimentalLog(reason).catch((e) => {
    logSidecar(
      'lifecycle',
      `experimental log upload failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

async function uploadExperimentalLog(reason: string): Promise<void> {
  const path = join(app.getPath('userData'), 'sidecar.log');
  if (!existsSync(path)) return;

  let logText = readFileSync(path, 'utf8');
  if (logText.length > MAX_LOG_BYTES) logText = logText.slice(-MAX_LOG_BYTES);
  if (!logText.trim()) return;

  const systemInfo = {
    os: process.platform,
    os_release: os.release(),
    arch: process.arch,
    app_version: app.getVersion(),
    electron: process.versions.electron,
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason, system_info: systemInfo, log_text: logText }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  logSidecar(
    'lifecycle',
    `experimental log uploaded (reason=${reason}${body.id ? `, id=${body.id}` : ''})`,
  );
}
