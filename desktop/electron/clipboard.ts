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
import { open, stat } from 'node:fs/promises';

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
    let handle;
    try {
      const info = await stat(path);
      // Only regular files. Don't trust stat().size to bound the read: special
      // files (e.g. /proc/*) report size 0 yet yield arbitrary bytes, so cap the
      // actual read at MAX_READ_BYTES and reject anything that exceeds it.
      if (!info.isFile() || info.size > MAX_READ_BYTES) return null;
      handle = await open(path, 'r');
      // Entscheidung 6.6: erst stat-size-begrenzt lesen, nur an der Cap-
      // Grenze zusätzlich ein Byte — vorher wurde JEDE Datei (auch ein
      // 5-KB-Bild) mit einem 100-MiB-Puffer gelesen. Special files (size 0,
      // beliebige Bytes) fallen in den gepufferten Pfad und prüfen dort.
      const sicherheitsPlus = 1;
      const chunkGroesse = Math.min(info.size, MAX_READ_BYTES) + sicherheitsPlus;
      const cap = Buffer.allocUnsafe(chunkGroesse);
      const { bytesRead } = await handle.read(cap, 0, cap.length, 0);
      if (bytesRead > MAX_READ_BYTES) return null;
      // Nachlesen: stat-size-0-Sonderdateien können mehr liefern als ein
      // Chunk — weiterlesen, bis MAX_READ_BYTES erreicht/überschritten.
      if (bytesRead === chunkGroesse && info.size === 0) {
        const gross = Buffer.allocUnsafe(MAX_READ_BYTES + 1);
        cap.copy(gross, 0);
        const { bytesRead: weitere } = await handle.read(gross, bytesRead, gross.length - bytesRead, bytesRead);
        const gesamt = bytesRead + weitere;
        if (gesamt > MAX_READ_BYTES) return null;
        return new Uint8Array(gross.subarray(0, gesamt));
      }
      return new Uint8Array(cap.subarray(0, bytesRead));
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  });
}
