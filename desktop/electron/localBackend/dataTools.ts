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

import { CONTAINER_NAME, DATA_VOLUME } from './containerBackendManager.ts';
import { rtExec, rtExecToFile, type ContainerRuntime } from './containerRuntime.ts';

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
    ? ['exec', CONTAINER_NAME, 'du', '-sk', '/data']
    : ['run', '--rm', '--entrypoint', 'du', '-v', `${DATA_VOLUME}:/data:ro`, image, '-sk', '/data'];
  const r = await rtExec(rt, args, { timeoutMs: 120_000 }).catch(() => null);
  return r?.code === 0 ? parseDuKb(r.stdout) : null;
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
      ['run', '--rm', '--entrypoint', 'tar', '-v', `${DATA_VOLUME}:/data:ro`, image, '-cf', '-', '-C', '/data', '.'],
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
