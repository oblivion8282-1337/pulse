/**
 * Vorschaubild + Originalmaße aus einer Bilddatei — der Klient rechnet beides
 * selbst aus (`createImageBitmap` + Canvas, dasselbe Muster wie
 * `AvatarUploadDialog`).
 *
 * Steht seit Etappe E in einer eigenen Datei, weil BEIDE Upload-Wege sie
 * brauchen: der Klartext-Weg (`upload.svelte.ts`) und der verschluesselte
 * (`uploadVerschluesselt.ts`). Im verschluesselten Weg ist sie sogar
 * unverzichtbar statt nur huebsch — der Server kennt dort keine Maße mehr,
 * also gaebe es ohne sie beim Empfaenger nichts, womit er den Platz vor dem
 * Laden reservieren koennte, und das Layout spraenge.
 */

/** Groesste Kante des Vorschaubildes. 720 bleibt inline lesbar, ohne ein
 *  zweites Bild in voller Aufloesung zu sein. */
const THUMB_MAX = 720;

export type Vorschaubild = {
  blob: Blob;
  thumbWidth: number;
  thumbHeight: number;
  origWidth: number;
  origHeight: number;
};

/** `null` fuer alles, was kein Bild ist — und fuer ein Bild, dessen Format der
 *  Browser nicht dekodieren kann. */
export async function erzeugeVorschaubild(file: File): Promise<Vorschaubild | null> {
  if (!file.type.startsWith('image/')) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null; // unsupported format — server still sees the original
  }
  const origWidth = bitmap.width;
  const origHeight = bitmap.height;
  const scale = Math.min(1, THUMB_MAX / Math.max(origWidth, origHeight));
  const w = Math.max(1, Math.round(origWidth * scale));
  const h = Math.max(1, Math.round(origHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.85));
  if (!blob) return null;
  return { blob, thumbWidth: w, thumbHeight: h, origWidth, origHeight };
}
