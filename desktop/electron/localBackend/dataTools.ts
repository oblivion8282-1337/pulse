/**
 * "Deine Daten"-Werkzeuge: belegte Größe des pulse-host-data-Volumes + Export.
 *
 * Größe — robustester Weg pro Zustand, OHNE zusätzliches Image zu ziehen:
 *  - Container läuft → `exec pulse-host du -sk /data` (am billigsten, kein
 *    neuer Container). `-sk` statt `-sb`: busybox-du kennt kein `-b`, `-k`
 *    können GNU und busybox.
 *  - Container steht → Wegwerf-Container mit dem BEREITS VORHANDENEN
 *    allinone-Image (`run --rm --entrypoint du`, Volume read-only). Der
 *    Mountpoint-Weg (`volume inspect` + du am Host) scheitert bei
 *    Podman-Machine (Win/Mac: Mountpoint liegt in der VM) — deshalb immer
 *    über die Runtime selbst.
 *
 * Export — EIN Pfad für beide Runtimes: tar auf stdout aus einem
 * Wegwerf-Container (`--entrypoint tar … -cf - -C /data .`), gestreamt in die
 * Zieldatei (rtExecToFile). Bewusst NICHT `podman volume export --output`:
 * dessen Zielpfad interpretiert das HOST-Podman — im Flatpak sähe es den vom
 * Save-Dialog gewählten Sandbox-/Portal-Pfad nicht. Über stdout landet der
 * Stream im Electron-Prozess, der den Zielpfad garantiert schreiben kann;
 * Docker (kein natives volume export) läuft identisch. Keine Electron-Imports.
 */

import { rmSync } from 'node:fs';

import { containerName, datenVolume } from './containerBackendManager.ts';
import { rtExec, rtExecFromFile, rtExecToFile, type ContainerRuntime } from './containerRuntime.ts';

/** Erste Zahl aus `du -sk`-Ausgabe ("12345\t/data") → Bytes, sonst null. */
export function parseDuKb(stdout: string): number | null {
  const m = /^(\d+)\s/.exec(stdout.trim());
  return m ? Number(m[1]) * 1024 : null;
}

/** Belegte Bytes des Daten-Volumes oder null (Fehler/nicht ermittelbar). */
export async function volumeSizeBytes(
  rt: ContainerRuntime,
  image: string,
  containerRunning: boolean,
): Promise<number | null> {
  const args = containerRunning
    ? ['exec', containerName(), 'du', '-sk', '/data']
    : ['run', '--rm', '--entrypoint', 'du', '-v', `${datenVolume()}:/data:ro`, image, '-sk', '/data'];
  const r = await rtExec(rt, args, { timeoutMs: 120_000 }).catch(() => null);
  return r?.code === 0 ? parseDuKb(r.stdout) : null;
}

/** Aus einer Backup-Datei `pulse-<UTC-Zeitstempel>.dump` die Epoche in ms.
 *  Der Dateiname IST der Zeitstempel (der Backup-Service im Image schreibt
 *  ihn so), also kein stat nötig. Fremde Namen → null. */
export function backupDateiZuMs(name: string): number | null {
  const m = /^pulse-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(name);
  if (!m) return null;
  const [, j, mo, tag, h, mi, s] = m;
  return Date.UTC(+j, +mo - 1, +tag, +h, +mi, +s);
}

/** Zeitstempel (ms) des neuesten automatischen pg_dumps in /data/backups —
 *  null, wenn keine da sind oder das Verzeichnis nicht lesbar ist. Gleiche
 *  Zwei-Wege wie volumeSizeBytes: exec im laufenden Container, sonst
 *  Wegwerf-Container. */
export async function lastAutoBackupAt(
  rt: ContainerRuntime,
  image: string,
  containerRunning: boolean,
): Promise<number | null> {
  const args = containerRunning
    ? ['exec', containerName(), 'ls', '-1', '/data/backups']
    : ['run', '--rm', '--entrypoint', 'ls', '-v', `${datenVolume()}:/data:ro`, image, '-1', '/data/backups'];
  const r = await rtExec(rt, args, { timeoutMs: 30_000 }).catch(() => null);
  if (r?.code !== 0) return null;
  let neueste = 0;
  for (const zeile of r.stdout.split('\n')) {
    const ms = backupDateiZuMs(zeile.trim());
    if (ms && ms > neueste) neueste = ms;
  }
  return neueste || null;
}

/** Importiert ein Export-tar zurück ins Volume (Gegenstück zu exportVolume):
 *  tar streamt aus der Quelldatei in die stdin eines Wegwerf-Containers
 *  (rtExecFromFile — gleicher Grund wie beim Export: Portal-/Sandbox-Pfade
 *  sieht nur der Electron-Prozess, und `podman volume import` gäbe es unter
 *  Docker ohnehin nicht). Der alte Bestand darf nicht mit dem importierten
 *  gemischt werden (Postgres-Datadir = Korruption), deshalb ersetzt der
 *  Import ihn ganz — aber erst NACH einem geprüften Entpacken
 *  (`IMPORT_SKRIPT`). Der Aufrufer (main.ts) stoppt/startet den Container
 *  drumherum. */
/** Shell-Ablauf des Imports im Wegwerf-Container (busybox-kompatibel).
 *
 *  Scan 2026-10-08: die frühere Fassung leerte /data VOR dem Entpacken — eine
 *  falsche Datei, ein kaputtes Archiv oder ein voller Datenträger hinterließ
 *  ein leeres Volume, und main.ts startete danach einen leeren Server unter
 *  denselben Zugangsdaten. Jetzt: erst in einen Nachbarordner entpacken, das
 *  Postgres-Datadir als Echtheitszeichen verlangen, erst dann den Bestand
 *  ersetzen. Preis: während des Imports liegt der Bestand doppelt im Volume.
 *  Scheitert ein Schritt vor dem Ersetzen, bleibt der alte Stand unberührt
 *  (`set -e` + `trap` räumen den Nachbarordner weg). */
export const IMPORT_SKRIPT = [
  'set -e',
  'Z=/data/.pulse-import',
  'trap \'rm -rf "$Z"\' EXIT',
  'rm -rf "$Z"',
  'mkdir "$Z"',
  'tar -xf - -C "$Z"',
  'test -f "$Z/pg/PG_VERSION" || { echo "kein Pulse-Backup (pg/PG_VERSION fehlt)" >&2; exit 3; }',
  'find /data -mindepth 1 -maxdepth 1 ! -name .pulse-import -exec rm -rf {} +',
  'find "$Z" -mindepth 1 -maxdepth 1 -exec mv {} /data/ \\;',
].join('\n');

export async function importVolume(
  rt: ContainerRuntime,
  image: string,
  sourcePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await rtExecFromFile(
      rt,
      [
        'run', '--rm', '-i', '--entrypoint', 'sh', '-v', `${datenVolume()}:/data`, image,
        '-c', IMPORT_SKRIPT,
      ],
      sourcePath,
      { timeoutMs: 60 * 60_000 },
    );
    if (r.code === 0) return { ok: true };
    if (r.code === 3) return { ok: false, error: 'Die Datei ist kein Pulse-Backup — die Daten sind unverändert.' };
    return { ok: false, error: `Import fehlgeschlagen (exit ${r.code}) — die Daten sind unverändert.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Exportiert das Volume als tar nach targetPath. Der Aufrufer (main.ts)
 *  stoppt/startet den Container drumherum — hier nur der reine Datenstrom.
 *  Fehlschlag räumt die halb geschriebene Zieldatei weg. */
export async function exportVolume(
  rt: ContainerRuntime,
  image: string,
  targetPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await rtExecToFile(
      rt,
      ['run', '--rm', '--entrypoint', 'tar', '-v', `${datenVolume()}:/data:ro`, image, '-cf', '-', '-C', '/data', '.'],
      targetPath,
      { timeoutMs: 60 * 60_000 },
    );
    if (r.code === 0) return { ok: true };
    try { rmSync(targetPath, { force: true }); } catch { /* best-effort */ }
    return { ok: false, error: `Export fehlgeschlagen (exit ${r.code})` };
  } catch (e) {
    try { rmSync(targetPath, { force: true }); } catch { /* best-effort */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
