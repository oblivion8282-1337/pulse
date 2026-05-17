/**
 * Windows-11 per-window audio screen capture.
 *
 * Background: on Windows the standard browser screenshare path captures
 * **system** audio when the user opts in — which means the audio from other
 * Pulse users (playing back through this Chrome process) leaks into the stream
 * and remote viewers hear themselves echoing. Chrome 141 (Sept 2025) shipped
 * `getDisplayMedia({ windowAudio: 'window' })` which, on Windows 11, uses the
 * WASAPI Application-Loopback API (`ActivateAudioInterfaceAsync` with
 * `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`) to capture only the audio of the
 * picked window's process tree. Voice-echo gone.
 *
 * LiveKit's `setScreenShareEnabled` won't help us reach this: its
 * `ScreenShareCaptureOptions` has no `windowAudio` field and its internal
 * `screenCaptureToDisplayMediaStreamOptions` whitelists fields. So we bypass:
 * call `getDisplayMedia` ourselves with the right constraints, then publish
 * the resulting tracks via `room.localParticipant.publishTrack`. The rest of
 * LiveKit (subscription, simulcast, codec selection on publish) still applies.
 *
 * Gated on `isWindows11()` + `chromiumMajorVersion() >= 141`. Falls back to
 * the regular LiveKit path on Win10 (`windowAudio` is silently ignored there,
 * but `systemAudio:"exclude"` would still strip audio → worse UX than today)
 * and on non-Chromium browsers (no `windowAudio` support at all).
 */

import { isWindows, isWindows11, chromiumMajorVersion } from '$lib/platform/runtime';

/** Augment the DOM lib — neither `windowAudio` (Chrome 141) nor `systemAudio`
 *  (older but still missing from this project's TS lib) are in TypeScript's
 *  `DisplayMediaStreamOptions`. Keep this colocated with the only call site. */
declare global {
  interface DisplayMediaStreamOptions {
    systemAudio?: 'include' | 'exclude';
    windowAudio?: 'exclude' | 'system' | 'window';
    selfBrowserSurface?: 'include' | 'exclude';
  }
}

/**
 * Decide synchronously whether to take the bypass path. Async-resolves the
 * Win11 probe (cached after first call). Non-Chromium / non-Win11 → false.
 */
export async function canUseWindowAudioCapture(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices?.getDisplayMedia) return false;
  if (!isWindows()) return false;
  const v = chromiumMajorVersion();
  if (v === null || v < 141) return false;
  return await isWindows11();
}

/**
 * Acquire a screen-capture stream targeted at a single window, with that
 * window's process-tree audio (no system mix, no echo of Pulse voice).
 *
 * The picker defaults to the Window tab (`displaySurface: 'window'` hint).
 * The user still has to tick "Share audio" in the picker — if they don't,
 * the resulting stream has no audio track. That's a Chromium UI thing and
 * not something we can drive from JS.
 */
export interface WindowedCaptureOptions {
  resolution?: { width: number; height: number; frameRate?: number };
}

export async function acquireWindowAudioStream(
  opts: WindowedCaptureOptions = {}
): Promise<MediaStream> {
  const videoConstraints: MediaTrackConstraints & { displaySurface?: 'window' } = {
    displaySurface: 'window'
  };
  if (opts.resolution) {
    videoConstraints.width = { ideal: opts.resolution.width };
    videoConstraints.height = { ideal: opts.resolution.height };
    if (opts.resolution.frameRate !== undefined) {
      videoConstraints.frameRate = { ideal: opts.resolution.frameRate };
    }
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints,
    audio: true,
    // Pulse-voice plays back inside *this* Chrome process. Excluding system
    // audio (which would mix it in on Win11) + targeting window audio (which
    // is the game's process tree, not Chrome) is what kills the echo.
    systemAudio: 'exclude',
    windowAudio: 'window',
    selfBrowserSurface: 'exclude'
  });
}
