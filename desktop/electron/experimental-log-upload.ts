/**
 * Diagnose-Log-Upload des Sidecars.
 *
 * Lädt bei Stream-Ende (und bei einem Stream-Fehler) die `sidecar.log` +
 * etwas Systeminfo an den Server hoch. Schalter: `uploadDiagnosticLogs`,
 * Tab „Diagnose".
 *
 * **Seit 2026-08-06 ist der Schalter standardmäßig AN** (Produktentscheidung).
 * Vorher war er aus und musste ausdrücklich eingeschaltet werden — mit der
 * damaligen Begründung, ein Standard-An wäre „stille Telemetrie für jeden
 * Nutzer". Diese Sorge ist nicht verschwunden, sie wird jetzt anders
 * beantwortet: nicht durch Schweigen, sondern durch Sichtbarkeit. Der
 * Schalter steht im UI ausdrücklich als „an" da, sagt, was übertragen wird,
 * und ist mit einem Klick abwählbar; die Umstellung selbst steht im
 * Changelog.
 *
 * Wer ausdrücklich abgewählt hat, bleibt abgewählt — siehe
 * {@link migriereAufStandardAn}.
 *
 * Der Opt-in hing noch früher am `useRustSidecar`-Toggle: solange Rust die
 * bewusst gewählte Ausnahme war, WAR dieser Toggle die Einwilligung. Seit
 * Rust der Standard ist, trägt er sie nicht mehr — daher ein eigener
 * Schalter.
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
import { storeGet, storeSet } from './store';

const ENDPOINT =
  process.env.PULSE_EXPERIMENTAL_LOG_URL ?? 'https://howispulse.com/api/experimental-logs';

/** Muss zum Server-`MAX_LOG_CHARS` (routes_experimental_logs.py) passen. */
const MAX_LOG_BYTES = 512 * 1024;

/** Pro Slot: kam seit dem letzten Start ein `error`-Event? → bestimmt `reason`. */
const sawError = new Map<number, boolean>();

/**
 * Bestandsinstallationen auf den neuen Standard heben. Einmal beim Start
 * aufrufen.
 *
 * **Warum das überhaupt nötig ist:** der Schalter kennt drei Zustände, nicht
 * zwei. Bis 2026-08-06 war die Vorgabe „aus", gespeichert wurde aber nur beim
 * Umschalten — es gibt also Installationen ohne den Schlüssel (nie angefasst,
 * die große Mehrheit), mit `true` (eingeschaltet) und mit `false`.
 *
 * Der fehlende Schlüssel erledigt sich von selbst: gelesen wird als
 * „nicht `false`", eine frische wie eine unberührte Installation ist damit an.
 *
 * **`false` wird NICHT überschrieben, und das ist Absicht.** Diesen Wert kann
 * nur bekommen haben, wer den Schalter selbst angefasst und wieder abgewählt
 * hat — eine ausdrückliche Willensbekundung. Sie zu übergehen wäre etwas
 * anderes als eine Vorgabe zu ändern, und es beträfe genau die Nutzer, die
 * gezeigt haben, dass sie es nicht wollen.
 */
export function migriereAufStandardAn(): void {
  if (storeGet('diagnosticsDefaultOnMigrated') === true) return;
  storeSet('diagnosticsDefaultOnMigrated', true);

  const bisher = storeGet('uploadDiagnosticLogs');
  logSidecar(
    'lifecycle',
    `diagnostics default-on migration: previous=${
      bisher === undefined ? 'unset' : String(bisher)
    } → ${bisher === false ? 'stays off (explicitly declined)' : 'on'}`,
  );
}

/**
 * Im `gsr:event`-Handler aufrufen. Sammelt `error`-Zustand und triggert beim
 * `stopped`-Event den Upload — no-op, wenn ausdrücklich abgewählt.
 */
export function onSidecarEventForUpload(ev: { ev?: string }, slot: number): void {
  if (ev.ev === 'error') {
    sawError.set(slot, true);
    return;
  }
  if (ev.ev !== 'stopped') return;

  const reason = sawError.get(slot) ? 'error' : 'stream_end';
  sawError.delete(slot);

  // Seit 2026-08-06 ist der Schalter standardmäßig AN — deshalb `!== false`
  // statt `!== true`: gesendet wird, solange niemand ausdrücklich abgewählt
  // hat. Ein fehlender Schlüssel (frische Installation) zählt als „an".
  if (storeGet('uploadDiagnosticLogs') === false) return;

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
