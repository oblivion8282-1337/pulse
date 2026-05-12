/**
 * Fullscreen helper shared by WhepPlayer and ScreenShareTile.
 *
 * Why the iOS fallback:
 *   On iPhone Safari, `HTMLElement.requestFullscreen` does not exist on arbitrary
 *   <div> containers — only `HTMLVideoElement.webkitEnterFullscreen()` is supported
 *   (and only when `webkitSupportsFullscreen` is true). Calling a missing method
 *   synchronously throws a TypeError that is NOT caught by a `.catch()` on the
 *   returned Promise (because there is no Promise — the call explodes before one
 *   can be created). The fix: feature-detect before calling, then fall back to
 *   the WebKit video API.
 */

// Non-standard WebKit properties present only on iPhone Safari.
type WebKitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

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

/** Returns true when the document is currently in standard fullscreen mode. */
export function isDocFullscreen(): boolean {
  return !!document.fullscreenElement;
}
