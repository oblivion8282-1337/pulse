/**
 * Platform/runtime detection.
 *
 * The web app ships in a few shapes: a plain browser SPA, and the same SPA
 * inside a desktop shell. The desktop wrapper is migrating from Tauri 2 (see
 * `desktop/src-tauri/`, still present) to Electron (`desktop/electron/`, E1a) —
 * Tauri's Linux WebKitGTK WebRTC is too unreliable for LiveKit voice. A few
 * features (global push-to-talk, native notifications, the GSR streaming UI)
 * only make sense in a desktop shell, some additionally only on Linux. Gate on
 * these helpers, never on a hand-rolled `navigator.userAgent` sniff scattered
 * around the codebase.
 */

/**
 * True when running inside the Tauri WebView. Tauri injects `__TAURI_INTERNALS__`
 * onto `window` before any app code runs, so this is reliable from module scope.
 * NOTE: kept for now; removed in E1c once the Tauri shell is gone.
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * True when running inside the Electron shell. The preload script
 * (`desktop/electron/preload.ts`) exposes `window.pulse = { platform: 'electron', ... }`
 * via contextBridge before any app code runs.
 */
export const isElectron = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { pulse?: { platform?: string } }).pulse?.platform === 'electron';

/** True in any desktop shell (Electron or — for now — Tauri). */
export const isDesktop = (): boolean => isElectron() || isTauri();

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
