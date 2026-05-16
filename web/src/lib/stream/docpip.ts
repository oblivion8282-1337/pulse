/**
 * Document Picture-in-Picture helpers — Chromium 116+ (Electron 42 ✓).
 *
 * Die API ergänzt die normale Video-PiP (nur Video) um ein OS-Floating-
 * Fenster mit beliebigem HTML. Wir clonen die Stylesheets + Dark-Mode-
 * Klasse ins neue Document, sodass Tailwind + shadcn-Tokens dort direkt
 * funktionieren.
 */

export interface DocumentPictureInPictureApi {
  requestWindow(opts?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }): Promise<Window>;
  window: Window | null;
}

export function getDocPip(): DocumentPictureInPictureApi | null {
  if (typeof window === 'undefined') return null;
  const api = (
    window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }
  ).documentPictureInPicture;
  return api ?? null;
}

export function docPipSupported(): boolean {
  return getDocPip() !== null;
}

/** Klont Stylesheets + Dark-Mode-Klasse aus `src` in `dst`. Same-origin-
 *  Sheets werden als inline-`<style>` geklont, cross-origin als `<link>`. */
export function adoptDocStyles(src: Document, dst: Document): void {
  for (const sheet of src.styleSheets) {
    try {
      const css = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
      const styleEl = dst.createElement('style');
      styleEl.textContent = css;
      dst.head.appendChild(styleEl);
    } catch {
      if (sheet.href) {
        const link = dst.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        dst.head.appendChild(link);
      }
    }
  }
  // Dark-Mode (mode-watcher setzt `.dark` aufs <html>).
  if (src.documentElement.classList.contains('dark')) {
    dst.documentElement.classList.add('dark');
  }
  dst.body.style.margin = '0';
  dst.body.style.background = '#000';
}
