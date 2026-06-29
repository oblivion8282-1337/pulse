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

/** Per-slot session fields — the live state of ONE of a user's HQ streams. */
type StreamSession = {
  running: boolean;
  state: 'idle' | 'starting' | 'live' | 'error' | 'stopped';
  fps: number | null;
  uptimeS: number | null;
  error: string | null;
  lastLog: string[];
};

/** The primary stream (slot 0). Also carries the GLOBAL bridge flags
 *  (`available`/`gsrAvailable`) since those describe the sidecar, not a slot —
 *  every existing component binds `stream`, so its shape is unchanged. */
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
  state: 'idle' as StreamSession['state'],
  fps: null as number | null,
  uptimeS: null as number | null,
  error: null as string | null,
  lastLog: [] as string[],
});

/** The optional second stream (slot 1) — e.g. a second monitor as its own
 *  viewer tile. Session-only: the global flags live on `stream`. */
export const streamExtra = $state({
  running: false,
  state: 'idle' as StreamSession['state'],
  fps: null as number | null,
  uptimeS: null as number | null,
  error: null as string | null,
  lastLog: [] as string[],
});

/** The session object for a given slot (0 = primary `stream`, 1 = `streamExtra`). */
export function streamForSlot(slot: number): StreamSession {
  return slot === 1 ? streamExtra : stream;
}

let initialised = false;
let unlisten: (() => void) | null = null;
/** Tracks each slot's running→stopped edge so we notify the backend exactly
 *  once per slot when that stream ends, regardless of which path stopped it. */
const wasRunning: Record<number, boolean> = { 0: false, 1: false };

/**
 * Tell the backend our HQ stream stopped so viewers' "live" badge clears at
 * once instead of waiting for the ~3s MediaMTX poll (+ its disconnect lag).
 * Central chokepoint: every stop path (rocket toggle, dialog button, hotkey,
 * voice-channel switch) funnels through the sidecar's `stopped` event, so this
 * is the one place that covers them all. Best-effort — the media-svc poller
 * stays the backstop if the call never lands (crash / offline / no channel).
 * Lazy imports avoid an import cycle with the voice store.
 */
function notifyBackendStopped(slot: number): void {
  void (async () => {
    const { voice } = await import('$lib/voice/livekit.svelte');
    const channelId = voice.channelId;
    if (!channelId) return; // already left the voice channel → poller cleans up
    const { chatApi } = await import('$lib/api/chat');
    chatApi.stopStream(channelId, slot).catch(() => {});
  })();
}

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

/** Project a single sidecar event into the reactive state of its slot. */
function applyEvent(ev: GsrEvent): void {
  const slot = ev.slot ?? 0;
  const s = streamForSlot(slot);
  applyEventInner(s, ev);
  // Fire on the running→stopped edge only (once per stream session, per slot).
  if (wasRunning[slot] && !s.running) {
    wasRunning[slot] = false;
    notifyBackendStopped(slot);
  } else if (s.running) {
    wasRunning[slot] = true;
  }
}

function applyEventInner(s: StreamSession, ev: GsrEvent): void {
  switch (ev.ev) {
    case 'state':
      s.state = ev.state;
      s.running = ev.running;
      s.uptimeS = ev.uptime_s;
      if (ev.state === 'live' || ev.state === 'starting') {
        s.error = null;
      }
      break;
    case 'fps':
      // Ignore stale fps ticks that arrive after a terminal stop — otherwise a
      // late fps event would flip the UI from 'stopped' back to 'live'.
      if (s.state === 'stopped') break;
      s.fps = ev.fps;
      s.uptimeS = ev.uptime_s;
      // FPS implies "live" even if the explicit state event hasn't landed.
      if (s.state !== 'live') s.state = 'live';
      s.running = true;
      break;
    case 'log':
      s.lastLog = [...s.lastLog, ev.line].slice(-MAX_LOG_LINES);
      break;
    case 'error':
      s.error = ev.message;
      break;
    case 'stopped':
      s.running = false;
      s.state = 'stopped';
      s.fps = null;
      break;
  }
}
