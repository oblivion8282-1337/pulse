/**
 * PID-Dateien + Aufräumen abgestürzter Vorläufe für das native Backend.
 *
 * Warum überhaupt: Windows beendet Kindprozesse NICHT mit dem Elternteil.
 * Nach einem Electron-Absturz liefen Postgres, Garnet, … weiter und hielten
 * die Ports — der nächste Start muss sie finden und beenden.
 *
 * Warum so vorsichtig: Windows vergibt PIDs neu, nach einem Neustart sofort.
 * Eine nackte Zahl in einer Datei zeigt dann auf irgendeinen Prozess — mit
 * `taskkill /T /F` hätte Pulse z. B. explorer.exe samt Baum beendet. Deshalb
 * steht in jeder PID-Datei auch der Image-Pfad und die Startzeit, und getötet
 * wird nur, wenn der lebende Prozess unter dieser PID in BEIDEM übereinstimmt.
 * Passt etwas nicht (oder ist die Datei im alten Nur-Zahl-Format), wird nur
 * die Datei entfernt.
 *
 * Die Prozess-Abfrage ist injizierbar, damit die Entscheidung unter Node auf
 * Linux prüfbar ist (test/localBackend/nativeHaertung.test.ts).
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, normalize } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Absoluter Pfad eines Windows-Systemprogramms. Ohne ihn nähme execFile das
 *  erste gleichnamige Programm im PATH — für `tar` wäre das bei installiertem
 *  Git for Windows dessen GNU-tar, das `C:\…` als Remote-Host deutet. */
export function systemProgramm(name: string, env: Record<string, string | undefined> = process.env): string {
  if (process.platform !== 'win32') return name.replace(/\.exe$/i, '');
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

export interface PidEintrag {
  pid: number;
  /** Pfad des gestarteten Programms (ServiceSpec.command). */
  image: string;
  /** Date.now() direkt nach dem Spawn. */
  gestartet: number;
}

export interface LebenderProzess {
  path: string | null;
  /** Startzeit in ms seit Epoch, null wenn nicht lesbar. */
  start: number | null;
}

/** Zulässige Abweichung zwischen unserem Zeitstempel und der Startzeit, die
 *  Windows meldet — beide entstehen im selben Augenblick, die Grenze fängt
 *  nur Uhr-Rundung und einen langsamen Spawn ab. */
const STARTZEIT_TOLERANZ_MS = 30_000;

function pidDateien(runDir: string): string[] {
  return readdirSync(runDir).filter((f) => f.endsWith('.pid'));
}

export function schreibePidDatei(runDir: string, name: string, eintrag: PidEintrag): void {
  writeFileSync(join(runDir, `${name}.pid`), JSON.stringify(eintrag), { encoding: 'utf8' });
}

/** null bei altem Format (nur Zahl) oder Unlesbarem — solche Dateien
 *  berechtigen zu keinem Kill. */
export function parsePidDatei(raw: string): PidEintrag | null {
  try {
    const v = JSON.parse(raw) as Partial<PidEintrag>;
    if (typeof v !== 'object' || v === null) return null;
    if (!Number.isInteger(v.pid) || (v.pid as number) <= 0) return null;
    if (typeof v.image !== 'string' || !v.image) return null;
    if (typeof v.gestartet !== 'number') return null;
    return { pid: v.pid as number, image: v.image, gestartet: v.gestartet };
  } catch {
    return null;
  }
}

function pfadGleich(a: string, b: string): boolean {
  // Windows-Pfade: Groß/Klein egal, Trenner egal.
  const n = (p: string): string => normalize(p.replace(/\\/g, '/')).toLowerCase();
  return n(a) === n(b);
}

/** Gehört der lebende Prozess noch zu dieser PID-Datei? */
export function gehoertUns(eintrag: PidEintrag, lebend: LebenderProzess | undefined): boolean {
  if (!lebend?.path || lebend.start === null) return false;
  if (!pfadGleich(lebend.path, eintrag.image)) return false;
  return Math.abs(lebend.start - eintrag.gestartet) <= STARTZEIT_TOLERANZ_MS;
}

/** Ausgabe der PowerShell-Abfrage (Zeilen `pid|pfad|startzeit-ISO`). */
export function parseProzessliste(stdout: string): Map<number, LebenderProzess> {
  const out = new Map<number, LebenderProzess>();
  for (const zeile of stdout.split(/\r?\n/)) {
    const [pidRoh, pfad, startRoh] = zeile.trim().split('|');
    const pid = Number(pidRoh);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const start = startRoh ? Date.parse(startRoh) : NaN;
    out.set(pid, { path: pfad || null, start: Number.isFinite(start) ? start : null });
  }
  return out;
}

export interface LaufresteDeps {
  prozessInfo: (pids: number[]) => Promise<Map<number, LebenderProzess>>;
  kill: (pid: number) => Promise<void>;
}

/** Windows-Standardweg: EIN PowerShell-Aufruf für alle PIDs (Get-Process
 *  liefert Path + StartTime; fremde Prozesse höherer Rechte ohne Path →
 *  zählen als „nicht unser“). */
export const windowsLaufresteDeps: LaufresteDeps = {
  async prozessInfo(pids) {
    if (process.platform !== 'win32' || pids.length === 0) return new Map();
    const liste = pids.map((p) => String(Math.trunc(p))).join(',');
    const skript =
      `Get-Process -Id ${liste} -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `"$($_.Id)|$($_.Path)|$(if ($_.StartTime) { $_.StartTime.ToUniversalTime().ToString('o') })" }`;
    try {
      const { stdout } = await execFileAsync(
        systemProgramm('WindowsPowerShell\\v1.0\\powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', skript],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true },
      );
      return parseProzessliste(stdout);
    } catch {
      return new Map(); // im Zweifel nichts töten
    }
  },
  async kill(pid) {
    if (process.platform !== 'win32') return;
    await execFileAsync(systemProgramm('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      .catch(() => {});
  },
};

/**
 * Alle PID-Dateien in runDir abarbeiten: nachweislich eigene Prozesse
 * beenden, jede Datei entfernen. Gibt die Zahl beendeter Prozesse zurück.
 */
export async function raeumeAlteLaeufe(runDir: string, deps: LaufresteDeps = windowsLaufresteDeps): Promise<number> {
  if (!existsSync(runDir)) return 0;
  const dateien = pidDateien(runDir);
  const eintraege: PidEintrag[] = [];
  for (const f of dateien) {
    let raw = '';
    try { raw = readFileSync(join(runDir, f), 'utf8'); } catch { /* unlesbar */ }
    const e = parsePidDatei(raw);
    if (e) eintraege.push(e);
  }
  let beendet = 0;
  if (eintraege.length) {
    const lebend = await deps.prozessInfo([...new Set(eintraege.map((e) => e.pid))]);
    for (const e of eintraege) {
      if (!gehoertUns(e, lebend.get(e.pid))) continue;
      await deps.kill(e.pid);
      beendet++;
    }
  }
  for (const f of dateien) rmSync(join(runDir, f), { force: true });
  return beendet;
}

/** Nach einem sauberen stop(): alle PID-Dateien weg. */
export function loeschePidDateien(runDir: string): void {
  if (!existsSync(runDir)) return;
  for (const f of pidDateien(runDir)) rmSync(join(runDir, f), { force: true });
}
