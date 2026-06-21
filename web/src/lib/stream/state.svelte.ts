/**
 * Reactive view onto the sidecar's stream state.
 *
 * Subscribes once to `gsr://event` (via `gsr.onEvent`) and projects the
 * stream of events into a Svelte-5-runes `$state` object. UI components can
 * import `stream` and bind directly.
 *
 * `initStream()` is idempotent — calling it twice (e.g. during HMR) does not
 * stack listeners. It is safe to call in a plain browser; it bails early.
 */

import { gsr, type GsrEvent } from './gsr';

const MAX_LOG_LINES = 50;

export const stream = $state({
  /** True iff the desktop sidecar bridge can be reached (i.e. we're inside the
   *  Electron shell AND the sidecar replied to `health`): `isElectron()` plus a
   *  successful health probe. */
  available: false,
  /** True iff the sidecar's health probe says `gsr.available === true` —
   *  i.e. a `gpu-screen-recorder` binary was located. Added in T3c so the
   *  voice-view HQ-Stream button can gate on real availability, not just
   *  "the bridge works". */
  gsrAvailable: false,
  running: false,
  state: 'idle' as 'idle' | 'starting' | 'live' | 'error' | 'stopped',
  fps: null as number | null,
  uptimeS: null as number | null,
  error: null as string | null,
  lastLog: [] as string[],
});

let initialised = false;
let unlisten: (() => void) | null = null;

/**
 * Wire the sidecar event stream into the `stream` reactive object. Returns a
 * disposer that unwires the subscription. Idempotent.
 */
export async function initStream(): Promise<() => void> {
  if (initialised) return () => {};
  initialised = true;

  stream.available = gsr.available();
  if (!stream.available) {
    // Reset the guard so a later call can retry if the bridge appears.
    initialised = false;
    return () => {};
  }

  // Pull an initial health probe so the UI can render quickly.
  try {
    const h = await gsr.health();
    // If the sidecar can't be reached the invoke throws (caught below); a
    // successful response just means the binding works. We expose the
    // `gsr.available` flag through `stream.gsrAvailable` so the voice-view
    // HQ-Stream button can gate on whether the binary is actually present.
    if (h) {
      if (!h.ok) stream.error = 'sidecar health probe failed';
      stream.gsrAvailable = !!h.gsr?.available;
    }
  } catch (e) {
    stream.available = false;
    stream.gsrAvailable = false;
    stream.error = String(e);
    // Reset the guard so a later call can retry if the sidecar recovers.
    initialised = false;
    return () => {};
  }

  unlisten = await gsr.onEvent(applyEvent);

  return () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    initialised = false;
  };
}

/** Project a single sidecar event into the reactive state. */
function applyEvent(ev: GsrEvent): void {
  switch (ev.ev) {
    case 'state':
      stream.state = ev.state;
      stream.running = ev.running;
      stream.uptimeS = ev.uptime_s;
      if (ev.state === 'live' || ev.state === 'starting') {
        stream.error = null;
      }
      break;
    case 'fps':
      // Ignore stale fps ticks that arrive after a terminal stop — otherwise a
      // late fps event would flip the UI from 'stopped' back to 'live'.
      if (stream.state === 'stopped') break;
      stream.fps = ev.fps;
      stream.uptimeS = ev.uptime_s;
      // FPS implies "live" even if the explicit state event hasn't landed.
      if (stream.state !== 'live') stream.state = 'live';
      stream.running = true;
      break;
    case 'log':
      stream.lastLog = [...stream.lastLog, ev.line].slice(-MAX_LOG_LINES);
      break;
    case 'error':
      stream.error = ev.message;
      break;
    case 'stopped':
      stream.running = false;
      stream.state = 'stopped';
      stream.fps = null;
      break;
  }
}
