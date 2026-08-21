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

import { getSidecar } from './sidecar';
import { logSidecar } from './sidecar-log';
import { storeGet, storeSet } from './store';

const ENDPOINT =
  process.env.PULSE_EXPERIMENTAL_LOG_URL ?? 'https://howispulse.com/api/experimental-logs';

/** Muss zum Server-`MAX_LOG_CHARS` (routes_experimental_logs.py) passen. */
const MAX_LOG_BYTES = 512 * 1024;

/**
 * Die Felder aus `health.gsr`, die in den Bericht wandern.
 *
 * Es sind die Fähigkeiten, an denen ein Encoder-Fehler hängt: ob 10 bit und
 * HDR überhaupt zur Verfügung standen, und welche Codecs die Karte anbot. Ohne
 * sie liest sich „AV1 ging nicht" wie ein Fehler, obwohl es womöglich schlicht
 * nicht angeboten war.
 */
const GSR_FELDER = ['vendor', 'display_server', 'video_codecs', 'ten_bit', 'hdr'];

/** Pro Slot: kam seit dem letzten Start ein `error`-Event? → bestimmt `reason`. */
const sawError = new Set<number>();

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
 * Ist die Diagnose-Übermittlung eingeschaltet?
 *
 * Seit 2026-08-06 ist der Schalter standardmäßig AN — deshalb `!== false`
 * statt `!== true`: gesendet wird, solange niemand ausdrücklich abgewählt hat.
 * Ein fehlender Schlüssel (frische Installation) zählt als „an".
 *
 * **Als Funktion und nicht als Vergleich an jeder Stelle**, weil daran seit dem
 * 2026-08-07 mehr hängt als der Upload selbst: der Player schaltet seine
 * Statistik-Zeilen danach ein (`player.ts`). Zwei Abfragen mit derselben
 * Absicht laufen früher oder später auseinander — und dann lädt die App ein
 * Protokoll hoch, in dem genau das fehlt, wofür sie es hochlädt.
 */
export function diagnoseEingeschaltet(): boolean {
  return storeGet('uploadDiagnosticLogs') !== false;
}

/**
 * Im `gsr:event`-Handler aufrufen. Sammelt `error`-Zustand und triggert beim
 * `stopped`-Event den Upload — no-op, wenn ausdrücklich abgewählt.
 */
export function onSidecarEventForUpload(ev: { ev?: string }, slot: number): void {
  if (ev.ev === 'error') {
    sawError.add(slot);
    return;
  }
  if (ev.ev !== 'stopped') return;

  const reason = sawError.has(slot) ? 'error' : 'stream_end';
  sawError.delete(slot);

  if (!diagnoseEingeschaltet()) return;

  void uploadExperimentalLog(reason, slot).catch((e) => {
    logSidecar(
      'lifecycle',
      `experimental log upload failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/**
 * Fragt beim Sidecar ab, was der Bericht über die Aufnahme-Seite braucht:
 * seine eigene Fassung und die Grafikkarte samt Anzeigesystem.
 *
 * **Beides fehlte bis 2026-08-06 in JEDEM hochgeladenen Bericht.**
 * `sidecar_version` war seit der ersten Fassung im Schema und stand
 * ausnahmslos auf NULL — es wurde nirgends befüllt. Und `system_info` trug nur
 * os/arch/app_version/electron, obwohl der Kommentar am Modell „GPU-Vendor /
 * Treiber" versprach. Damit war bei einem Bericht über einen Encoder-Fehler
 * genau das nicht dabei, worauf man zuerst sieht: welche Karte, welcher Codec,
 * X11 oder Wayland.
 *
 * Beide Abfragen sind lesende Operationen und starten den Sidecar nicht neu.
 * **Sie dürfen den Upload nicht scheitern lassen**: der Sidecar ist beim
 * Stream-Ende gerade heruntergefahren oder gar abgestürzt — und dann ist der
 * Bericht besonders wertvoll. Ein Fehler hier liefert deshalb nur `null`
 * zurück, statt den ganzen Versand mitzunehmen.
 */
async function sidecarAngaben(
  slot: number,
): Promise<{ version: string | null; gpu: Record<string, unknown> }> {
  const gpu: Record<string, unknown> = {};
  let version: string | null = null;
  const sidecar = getSidecar(slot);

  try {
    const health = (await sidecar.call('health')) as {
      version?: string;
      gsr?: Record<string, unknown>;
    };
    if (typeof health.version === 'string') version = health.version;
    const faehigkeiten = health.gsr;
    if (faehigkeiten && typeof faehigkeiten === 'object') {
      for (const feld of GSR_FELDER) {
        if (faehigkeiten[feld] !== undefined) gpu[feld] = faehigkeiten[feld];
      }
    }
  } catch {
    // still: siehe Funktionskommentar
  }

  try {
    const info = (await sidecar.call('gpu_info')) as Record<string, unknown>;
    // Ergänzt, was `health` nicht führt (etwa `card_path`), ohne dessen Werte
    // zu überschreiben — `health` ist die Quelle, an der sich der Rest der App
    // ebenfalls orientiert.
    for (const [k, v] of Object.entries(info)) {
      if (gpu[k] === undefined && k !== 'id' && k !== 'ok') gpu[k] = v;
    }
  } catch {
    // still
  }

  return { version, gpu };
}

async function uploadExperimentalLog(reason: string, slot: number): Promise<void> {
  const path = join(app.getPath('userData'), 'sidecar.log');
  if (!existsSync(path)) return;

  let logText = readFileSync(path, 'utf8');
  if (logText.length > MAX_LOG_BYTES) logText = logText.slice(-MAX_LOG_BYTES);
  if (!logText.trim()) return;

  const { version, gpu } = await sidecarAngaben(slot);

  const systemInfo = {
    os: process.platform,
    os_release: os.release(),
    arch: process.arch,
    app_version: app.getVersion(),
    electron: process.versions.electron,
    ...gpu,
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reason,
      // Ausdrücklich als Senderseite kennzeichnen. Seit es auch
      // Zuschauerberichte gibt, ist die Frage „welche Seite meldet das"
      // nicht mehr durch Schweigen beantwortet.
      role: 'sender',
      sidecar_version: version,
      system_info: systemInfo,
      log_text: logText,
    }),
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
