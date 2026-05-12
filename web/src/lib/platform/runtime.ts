/**
 * Platform/runtime detection.
 *
 * The web app ships in a few shapes: a plain browser SPA, and the same SPA
 * inside the Electron desktop shell (`desktop/electron/`). A few features
 * (global push-to-talk, native notifications, the GSR streaming UI) only make
 * sense in the desktop shell, some additionally only on Linux. Gate on these
 * helpers, never on a hand-rolled `navigator.userAgent` sniff scattered around
 * the codebase.
 *
 * (Historic: the desktop shell was Tauri 2 (`desktop/src-tauri/`) until
 * 2026-05-12 — its Linux WebKitGTK WebRTC was too unreliable for LiveKit voice,
 * so it was migrated to Electron in E1. See PLAN.md §17.)
 *
 * The `window.pulse` shape is declared in `./pulse.d.ts`.
 */

/**
 * True when running inside the Electron shell. The preload script
 * (`desktop/electron/preload.ts`) exposes `window.pulse = { platform: 'electron', ... }`
 * via contextBridge before any app code runs.
 */
export const isElectron = (): boolean =>
  typeof window !== 'undefined' && window.pulse?.platform === 'electron';

/** True in the desktop shell. Currently synonymous with `isElectron()`; kept as
 *  a separate name in case other shells ever appear (and so call sites read as
 *  intent, not implementation). */
export const isDesktop = (): boolean => isElectron();

/**
 * Best-effort "are we on Linux?" check.
 *
 * A UA-based guess is good enough for our gates (the GSR streaming UI also
 * checks `isElectron()` and a sidecar health probe). TODO: if we ever need a
 * rock-solid OS check, surface `process.platform` from the Electron preload.
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
