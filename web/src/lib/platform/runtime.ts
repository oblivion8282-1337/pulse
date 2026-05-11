/**
 * Platform/runtime detection.
 *
 * The web app ships in two shapes: a plain browser SPA and the same SPA inside
 * the Tauri 2 desktop shell (see `desktop/`). A few features (global push-to-talk,
 * native notifications, the GSR streaming UI in T3) only make sense under Tauri,
 * and some of those additionally only on Linux. Gate on these helpers, never on
 * a hand-rolled `navigator.userAgent` sniff scattered around the codebase.
 */

/**
 * True when running inside the Tauri WebView. Tauri injects `__TAURI_INTERNALS__`
 * onto `window` before any app code runs, so this is reliable from module scope.
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Best-effort "are we on Linux?" check.
 *
 * Note: this is intentionally NOT using `@tauri-apps/plugin-os` — that would be
 * an extra Rust+npm dependency we don't otherwise need in T1. For T1's purposes
 * (and the T3 streaming-UI gate, which also checks `isTauri()` and a sidecar
 * health probe) a UA-based guess is good enough. TODO(T3): if we need a
 * rock-solid OS check, add `@tauri-apps/plugin-os` and switch to `platform()`.
 */
export const isLinux = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  // `userAgentData.platform` is the modern API (Chromium); fall back to UA string.
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = (uaData?.platform ?? navigator.platform ?? '').toLowerCase();
  if (platform) return platform.includes('linux') && !platform.includes('android');
  return /\blinux\b/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);
};
