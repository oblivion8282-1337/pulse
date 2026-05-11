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
  available: false,
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
    return () => {};
  }

  // Pull an initial health probe so the UI can render quickly.
  try {
    const h = await gsr.health();
    // If the sidecar can't be reached the invoke throws (caught below); a
    // successful response just means the binding works. We don't try to
    // expose the full health payload through `stream` — the dev UI calls
    // `gsr.health()` directly for that.
    if (h && !h.ok) {
      stream.error = 'sidecar health probe failed';
    }
  } catch (e) {
    stream.available = false;
    stream.error = String(e);
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
