/**
 * Pulse desktop shell — display-sleep inhibitor for active video viewing.
 *
 * The renderer decides WHEN the screen must stay awake (a watch-party or HQ
 * stream is actively playing) and toggles it via `window.pulse.power.keepAwake`.
 * This module maps that to a single Electron `powerSaveBlocker`. Refcounting
 * lives in the renderer (`$lib/platform/wakeLock`), so here we hold at most one
 * blocker and just start/stop it idempotently.
 *
 * We use `'prevent-display-sleep'`, NOT `'prevent-app-suspension'`: only the
 * monitor/DPMS is inhibited — the machine can still suspend normally if the
 * user closes the lid etc.
 *
 * On Linux `powerSaveBlocker` drives the org.freedesktop.ScreenSaver / logind
 * inhibit interface, which is what desktop power settings actually honour. The
 * browser Screen Wake Lock API is unreliable inside Electron there, which is
 * why the renderer prefers this bridge when running under Electron.
 */

import { ipcMain, powerSaveBlocker } from 'electron';

let blockerId: number | null = null;

function isActive(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

export function wirePower(): void {
  ipcMain.handle('power:keepAwake', (_e, on: unknown): boolean => {
    const want = on === true;
    if (want) {
      if (!isActive()) blockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    return isActive();
  });
}
