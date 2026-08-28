/**
 * PUT einer Datei auf eine vorsignierte Adresse, mit Fortschritt und
 * Abbruch — XHR statt `fetch`, weil nur XHR einen Fortschrittsstrom fuer den
 * HOCHLADE-Teil liefert.
 *
 * Seit Etappe E in einer eigenen Datei: der Klartext-Weg
 * (`upload.svelte.ts`) und der verschluesselte (`uploadVerschluesselt.ts`)
 * laden beide so hoch — nur der Inhalt und die Adresse unterscheiden sich.
 */
export function putMitFortschritt(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (pct: number) => void,
  registerAbort: (abort: () => void) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerAbort(() => xhr.abort());
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`PUT ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(blob);
  });
}
