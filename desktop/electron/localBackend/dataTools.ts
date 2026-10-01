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

/** Exportiert das Volume als tar nach targetPath. Der Aufrufer (main.ts)
 *  stoppt/startet den Container drumherum — hier nur der reine Datenstrom.
 *  Fehlschlag räumt die halb geschriebene Zieldatei weg. */
/** Importiert ein Export-tar zurück ins Volume (Gegenstück zu exportVolume):
 *  tar streamt aus der Quelldatei in die stdin eines Wegwerf-Containers
 *  (rtExecFromFile — gleicher Grund wie beim Export: Portal-/Sandbox-Pfade
 *  sieht nur der Electron-Prozess, und `podman volume import` gäbe es unter
 *  Docker ohnehin nicht). VOR dem Entpacken wird /data geleert — ein Restore
 *  über einen Bestand hinweg würde sonst alte DB-Dateien mit importierten
 *  mischen (Postgres-Datadir = Korruption). busybox-kompatibel: `find
 *  -mindepth 1 -delete` räumt auch dotfiles. Der Aufrufer (main.ts) stoppt/
 *  startet den Container drumherum. */
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
        '-c', 'find /data -mindepth 1 -delete && tar -xf - -C /data',
      ],
      sourcePath,
      { timeoutMs: 60 * 60_000 },
    );
    if (r.code === 0) return { ok: true };
    return { ok: false, error: `Import fehlgeschlagen (exit ${r.code})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
