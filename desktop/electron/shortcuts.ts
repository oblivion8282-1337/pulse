/**
 * Pulse desktop shell — OS-global keyboard shortcuts.
 *
 * The in-window shortcut engine (`web/src/lib/shortcuts/engine.svelte.ts`) only
 * sees keydowns while the window is focused. To let the background-capable
 * toggles (mute / deafen / disconnect / stream) fire while Pulse is in the
 * background, the renderer hands us the current bindings — already converted to
 * Electron accelerators — and we register them globally.
 *
 * The renderer owns the policy (WHICH actions, see `lib/shortcuts/desktop.ts`)
 * and the combo→accelerator conversion; we just register and echo the fired
 * action id back over `shortcuts:trigger`, where the renderer dispatches it
 * through the same handler registry as a focused press.
 *
 * `globalShortcut` swallows a registered accelerator system-wide, so a focused
 * press goes through this path too (no double-fire with the window listener).
 * If an accelerator is already owned by another app, `register` throws — we
 * skip it, and the in-window listener still handles it while Pulse is focused.
 *
 * Note: `globalShortcut` only fires on press, not release — so this covers
 * edge-triggered toggles, NOT hold-to-talk PTT (that still needs a native
 * key-listener; see the TODO in `main.ts`).
 */

import { ipcMain, globalShortcut, BrowserWindow } from 'electron';

type Binding = { id: string; accelerator: string };

function sanitise(list: unknown): Binding[] {
  if (!Array.isArray(list)) return [];
  const out: Binding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { id, accelerator } = item as Record<string, unknown>;
    if (typeof id === 'string' && typeof accelerator === 'string' && accelerator.length > 0) {
      out.push({ id, accelerator });
    }
  }
  return out;
}

export function wireGlobalShortcuts(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('shortcuts:setGlobal', (_e, list: unknown) => {
    globalShortcut.unregisterAll();
    for (const b of sanitise(list)) {
      try {
        globalShortcut.register(b.accelerator, () => {
          getWindow()?.webContents.send('shortcuts:trigger', b.id);
        });
      } catch {
        // Accelerator already owned by another app, or malformed — skip it.
        // The in-window listener still handles this action when Pulse is focused.
      }
    }
  });
}
