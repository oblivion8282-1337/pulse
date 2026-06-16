/**
 * Pulse desktop shell — native clipboard + dropped-file byte access.
 *
 * The desktop app loads the *remote* web app in a sandboxed renderer, where the
 * bytes of a pasted or OS-dropped file come through empty (size 0 → upload 422).
 * This module gives the renderer two native escape hatches so paste + drag-drop
 * of images/files work in the app the same way they do in a browser:
 *
 *   clipboard:readImage  — current clipboard image as PNG bytes (or null)
 *   file:readPath        — the bytes of a file at an absolute path
 *
 * Security: `file:readPath` is an arbitrary-file read, but the renderer *page*
 * can never reach it with a path of its choosing. The preload resolves the path
 * from a genuine dropped `File` via `webUtils.getPathForFile` — which only
 * returns a path for real OS files the user dragged in (a JS-constructed File
 * yields ''), and `ipcRenderer` itself is not exposed to the page. We still cap
 * the size as a backstop against a huge accidental read.
 */

import { ipcMain, clipboard } from 'electron';
import { readFile, stat } from 'node:fs/promises';

// Hard ceiling so a single read can't blow up memory. The server enforces the
// real per-file attachment limit; this is just a sanity backstop.
const MAX_READ_BYTES = 100 * 1024 * 1024; // 100 MiB

export function wireClipboard(): void {
  // Clipboard image → PNG bytes. Returns null when the clipboard holds no image
  // (e.g. a plain-text copy) so the renderer can fall through to text paste.
  ipcMain.handle('clipboard:readImage', (): Uint8Array | null => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      const png = img.toPNG();
      if (!png || png.length === 0) return null;
      return new Uint8Array(png);
    } catch {
      return null;
    }
  });

  // Read a dropped file's bytes by absolute path. The path originates from
  // webUtils.getPathForFile in the preload (real drop only) — see module doc.
  ipcMain.handle('file:readPath', async (_e, path: unknown): Promise<Uint8Array | null> => {
    if (typeof path !== 'string' || !path) return null;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_READ_BYTES) return null;
      const buf = await readFile(path);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  });
}
