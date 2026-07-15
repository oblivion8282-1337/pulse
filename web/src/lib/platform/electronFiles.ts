/**
 * Electron drag-drop file recovery.
 *
 * In the desktop app the sandboxed remote renderer can't read the bytes of an
 * OS-dropped file (size 0 → upload 422), so drop of files is disabled there by
 * default. When a current Electron shell is running it exposes a native bridge
 * (`window.pulse.files`) that recovers the real bytes; these helpers wrap it
 * and hand back proper File objects. In a browser (or an older shell without
 * the bridge) the capability check returns false and callers keep their
 * existing browser behaviour.
 */

/** True when the running shell can recover dropped-file bytes natively. */
export function canRecoverDroppedFiles(): boolean {
  return typeof window !== 'undefined' && !!window.pulse?.files?.readDropped;
}

/** Recover real File objects for a drop's FileList under Electron. Name + type
 *  come from the original File (those ARE readable — only the bytes are 0);
 *  files whose bytes can't be read are dropped. Files that already carry bytes
 *  are passed through untouched. */
export async function recoverDroppedFiles(list: FileList | File[]): Promise<File[]> {
  const files = Array.from(list);
  const api = window.pulse?.files;
  if (!api?.readDropped) return files; // no bridge → best effort (browser path)
  const out: File[] = [];
  for (const f of files) {
    if (f.size > 0) {
      out.push(f);
      continue;
    }
    const bytes = await api.readDropped(f);
    if (bytes && bytes.length > 0) {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps TS's
      // stricter ArrayBufferLike-vs-ArrayBuffer typing for the byte buffer.
      out.push(new File([bytes as BlobPart], f.name, { type: f.type }));
    }
  }
  return out;
}
