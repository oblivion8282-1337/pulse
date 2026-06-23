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

/**
 * True inside the Capacitor Android wrapper app (the APK that loads
 * howispulse.com remotely). Capacitor injects a native bridge whose
 * `isNativePlatform()` returns true there and never in a plain browser. This
 * wrapper is Android-only, so native-platform is a sufficient signal (we
 * deliberately don't gate on `getPlatform() === 'android'` — under a
 * `server.url` config some Capacitor versions report `'web'` there, which would
 * wrongly hide native UI). Used to gate native-only controls like the
 * earpiece/speaker audio toggle (the native `AudioRoute` plugin).
 */
export const isCapacitorAndroid = (): boolean => {
  if (typeof window === 'undefined') return false;
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  return !!cap?.isNativePlatform?.();
};

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

/**
 * Best-effort "are we on a phone/tablet?" check.
 *
 * Used to switch the remote voice-audio playback path: mobile browsers
 * (Android Chrome, iOS Safari) and the Android TWA suspend a *backgrounded*
 * AudioContext within seconds of a screen lock, which kills call audio. On
 * those we play remote mic tracks through an unmuted `<audio>` element — which
 * the OS keeps alive as background media — instead of the Web Audio gain graph
 * (see `voice/audioElements.ts`). Never true in the desktop Electron shell.
 */
export const isMobile = (): boolean => {
  if (isElectron()) return false;
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  if (typeof uaData?.mobile === 'boolean') return uaData.mobile;
  // iPadOS 13+ ships a macOS-like UA, so the UA regex misses it — detect the
  // touch-capable "Mac" separately.
  const ua = navigator.userAgent;
  const isIpad = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return isIpad || /Android|iPhone|iPad|iPod/i.test(ua);
};

/** Best-effort "are we on Windows?" check. Same shape as `isLinux()`. */
export const isWindows = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = (uaData?.platform ?? navigator.platform ?? '').toLowerCase();
  if (platform) return platform.includes('win');
  return /\bwindows\b/i.test(navigator.userAgent);
};

/**
 * Best-effort "are we on macOS?" check. Same shape as `isLinux()`/`isWindows()`.
 *
 * Note: iPadOS 13+ reports a macOS-like UA/platform, so this can be true on an
 * iPad. That's fine for the HQ-streaming gate (it additionally requires
 * `isElectron()` + a sidecar health probe, neither of which holds on iPad). If a
 * future Mac-only gate must exclude iPadOS, combine with `!isMobile()`.
 */
export const isMac = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = (uaData?.platform ?? navigator.platform ?? '').toLowerCase();
  if (platform) return platform.includes('mac');
  return /\bmac(intosh)?\b/i.test(navigator.userAgent);
};

/** Chromium major-version, parsed from `Chrome/<N>.…` in the UA string. Returns
 *  `null` for non-Chromium browsers. Edge ships with `Chrome/<same-N>` so this
 *  works for both. */
export const chromiumMajorVersion = (): number | null => {
  if (typeof navigator === 'undefined') return null;
  const m = /Chrome\/(\d+)\./.exec(navigator.userAgent);
  return m ? parseInt(m[1], 10) : null;
};

/**
 * Probe (async, cached) whether we are on Windows 11.
 *
 * UA-CH `platformVersion` for Windows: major `0..12` = Win10, `13+` = Win11.
 * See https://learn.microsoft.com/en-us/microsoft-edge/web-platform/how-to-detect-win11.
 * Returns `false` on non-Chromium browsers (no `getHighEntropyValues`) and on
 * non-Windows. Result is cached after first call.
 *
 * Used by the screen-share path to decide whether `getDisplayMedia` will
 * honour `windowAudio:"window"` — that feature is Win11-only (gated on
 * `kApplicationAudioCaptureWin` + WASAPI ProcessLoopback availability inside
 * Chromium).
 */
let _isWindows11Cache: boolean | null = null;
let _isWindows11Probe: Promise<boolean> | null = null;
export const isWindows11 = (): Promise<boolean> => {
  if (_isWindows11Cache !== null) return Promise.resolve(_isWindows11Cache);
  if (_isWindows11Probe) return _isWindows11Probe;
  _isWindows11Probe = (async () => {
    if (!isWindows()) return false;
    const uaData = (
      navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues?: (
            hints: string[]
          ) => Promise<{ platformVersion?: string }>;
        };
      }
    ).userAgentData;
    if (!uaData?.getHighEntropyValues) return false;
    try {
      const high = await uaData.getHighEntropyValues(['platformVersion']);
      const ver = high.platformVersion;
      if (!ver) return false;
      return parseInt(ver.split('.')[0] ?? '0', 10) >= 13;
    } catch {
      return false;
    }
  })().then((v) => {
    _isWindows11Cache = v;
    return v;
  });
  return _isWindows11Probe;
};
