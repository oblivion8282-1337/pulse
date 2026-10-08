/**
 * Vollbild-Helfer für WhepPlayer, ScreenShareTile und CameraTile.
 *
 * Warum es überhaupt einen Sonderweg braucht:
 *   Am iPhone gibt es `HTMLElement.requestFullscreen` auf beliebigen
 *   <div>-Containern NICHT — nur `HTMLVideoElement.webkitEnterFullscreen()`
 *   (und das nur, wenn `webkitSupportsFullscreen` gilt). Der Aufruf einer
 *   fehlenden Methode wirft synchron einen TypeError, den ein `.catch()` am
 *   Rückgabewert NICHT fängt (es gibt keinen Promise — der Aufruf fliegt,
 *   bevor einer entstehen kann). Deshalb wird erst geprüft, dann gerufen.
 *
 * **`webkitEnterFullscreen` ist seit dem 2026-10-08 nicht mehr der Weg am
 * Telefon, und das ist der Kern dieser Datei.** Es öffnet Apples SYSTEMPLAYER,
 * und der ersetzt unsere Oberfläche vollständig — mitsamt dem
 * Lautstärke-Regler der Kachel. Dieser Regler wirkt auf den Web-Audio-Graphen
 * des Streams (`hqStreamManager`: das <video> ist stumm, der Ton läuft
 * daneben), er ist also von der Sprachkanal-Lautstärke GETRENNT. Der
 * Systemplayer kennt nur die Geräte-Lautstärke, und die gilt für Voice mit:
 * ein lauter Stream übertönt dort die Leute im Sprachkanal, ein leiser geht
 * unter. Genau deshalb gibt es `eigenesVollbildNoetig` — wo die Fullscreen-API
 * fehlt, baut die Kachel ihr Vollbild selbst und behält ihre Steuerung.
 * Der WebKit-Weg bleibt nur als letzter Rückfall, wenn ein echtes
 * `requestFullscreen` ABGELEHNT wird (Container in einem fremden iframe).
 */

// Non-standard WebKit properties present only on iPhone Safari.
type WebKitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

/**
 * `true`, wenn dieser Container kein echtes Element-Vollbild kann und die
 * Kachel ihr Vollbild deshalb SELBST bauen muss (`fixed inset-0`).
 *
 * Das trifft am iPhone zu — in der Capacitor-Hülle wie in mobile Safari. Die
 * Prüfung hängt bewusst an der FÄHIGKEIT, nicht an einer Plattform-Abfrage:
 * sie ist damit auch dann richtig, wenn ein Browser die API nachliefert oder
 * eine andere sie wegnimmt.
 */
export function eigenesVollbildNoetig(container: HTMLElement | null): boolean {
  return !container?.requestFullscreen;
}

/**
 * Toggle fullscreen for a player tile.
 *
 * @param container  The wrapping <div> — used for standard fullscreen.
 * @param video      The <video> element — used as iOS fallback.
 */
export function toggleFullscreen(
  container: HTMLElement | null,
  video: HTMLVideoElement | null
): void {
  // Exit fullscreen if we are already in it (any element).
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    return;
  }

  // Standard path: div container supports requestFullscreen (all non-iPhone browsers).
  if (container?.requestFullscreen) {
    container.requestFullscreen().catch(() => {
      // Last-resort fallback: try the video element even on standard browsers
      // (e.g. when the container is inside a cross-origin iframe).
      tryWebkitFullscreen(video);
    });
    return;
  }

  // iPhone Safari fallback: no requestFullscreen on arbitrary elements.
  tryWebkitFullscreen(video);
}

function tryWebkitFullscreen(video: HTMLVideoElement | null): void {
  if (!video) return;
  const wk = video as WebKitVideo;
  try {
    if (wk.webkitSupportsFullscreen && wk.webkitEnterFullscreen) {
      wk.webkitEnterFullscreen();
    }
  } catch {
    // Nothing we can do — iOS may refuse if the video has no src yet.
  }
}
