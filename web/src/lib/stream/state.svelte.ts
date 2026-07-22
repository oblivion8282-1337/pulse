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

import { toast } from 'svelte-sonner';
import { gsr, type GsrEvent } from './gsr';
import { m } from '$lib/paraglide/messages.js';

const MAX_LOG_LINES = 50;

/** How many concurrent HQ streams one user may run (slots 0..MAX-1, e.g. one
 *  per monitor). Keep in sync with the Electron `MAX_STREAM_SLOTS` and the
 *  backend `_SLOT_MAX` (= MAX_STREAM_SLOTS - 1). */
export const MAX_STREAM_SLOTS = 4;

/** Per-slot session fields — the live state of ONE of a user's HQ streams. */
type StreamSession = {
  running: boolean;
  state: 'idle' | 'starting' | 'live' | 'error' | 'stopped';
  fps: number | null;
  uptimeS: number | null;
  error: string | null;
  lastLog: string[];
};

/** A fresh, idle session — the per-slot defaults shared by `stream` (slot 0)
 *  and every entry of `extraSessions`. */
function freshSession(): StreamSession {
  return {
    running: false,
    state: 'idle',
    fps: null,
    uptimeS: null,
    error: null,
    lastLog: [],
  };
}

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
  ...freshSession(),
});

/** The additional streams (slots 1..MAX-1) — each a second/third/… monitor as
 *  its own viewer tile. Session-only: the global flags live on `stream`.
 *  Deep-`$state` array → mutating `extraSessions[i].running` is reactive. */
const extraSessions = $state<StreamSession[]>(
  Array.from({ length: MAX_STREAM_SLOTS - 1 }, freshSession)
);

/** The session object for a slot (0 = primary `stream`, ≥1 = an extra stream). */
export function streamForSlot(slot: number): StreamSession {
  return slot === 0 ? stream : extraSessions[slot - 1];
}

/** Slots that currently have a running stream (0 = primary). Reactive — call
 *  inside a `$derived`. */
export function runningStreamSlots(): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < MAX_STREAM_SLOTS; slot++) {
    if (streamForSlot(slot).running) slots.push(slot);
  }
  return slots;
}

let initialised = false;
let unlisten: (() => void) | null = null;
/** Tracks each slot's running→stopped edge so we notify the backend exactly
 *  once per slot when that stream ends, regardless of which path stopped it. */
const wasRunning: Record<number, boolean> = {};

/**
 * How long ``starting`` may run before we give up and flip the slot to
 * ``error``. The sidecar emits ``starting`` when it kicks the encoder off, then
 * ``live`` (or fps ticks) once the publisher is detected server-side. If
 * neither lands — encoder init failed silently, the RTMPS push never connected,
 * the sidecar hung — the UI would otherwise sit on "Connecting…" forever with
 * no clue. Generous: covers encoder warmup + RTMPS handshake + the ~3 s
 * server-side poller that detects the publisher. See the matching startup
 * watchdog in ``hqStreamManager.svelte.ts`` (viewer side).
 */
const START_TIMEOUT_MS = 20_000;
const startTimers: Record<number, ReturnType<typeof setTimeout>> = {};

function clearStartWatchdog(slot: number): void {
  const t = startTimers[slot];
  if (t !== undefined) {
    clearTimeout(t);
    delete startTimers[slot];
  }
}

function armStartWatchdog(slot: number): void {
  if (startTimers[slot] !== undefined) return; // already armed — don't reset the countdown
  startTimers[slot] = setTimeout(() => {
    delete startTimers[slot];
    const s = streamForSlot(slot);
    // Only fire if we're STILL waiting — a late `live`/`error`/`stopped` has
    // already cleared the timer; this guards against a stray fires-after-clear.
    if (s.state === 'starting') {
      s.state = 'error';
      s.error = m.stream_error_start_timeout();
    }
  }, START_TIMEOUT_MS);
}

function clearAllStartWatchdogs(): void {
  for (const slot of Object.keys(startTimers)) clearStartWatchdog(Number(slot));
}

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
    clearAllStartWatchdogs();
    initialised = false;
  };
}

/**
 * Mark a slot as (re)starting from OUTSIDE the sidecar event stream — used by
 * the auto-restart path, which flips the UI to "Connecting…" before the fresh
 * sidecar's own `starting` event lands. Arms the same startup watchdog as a
 * sidecar-driven `starting`, so a restart that dies silently still surfaces
 * as an error instead of hanging on "Connecting…" forever.
 */
export function markStarting(slot: number): void {
  const s = streamForSlot(slot);
  s.state = 'starting';
  s.error = null;
  armStartWatchdog(slot);
}

/** Project a single sidecar event into the reactive state of its slot. */
function applyEvent(ev: GsrEvent): void {
  const slot = ev.slot ?? 0;
  const s = streamForSlot(slot);
  applyEventInner(s, ev);
  // Arm the startup watchdog while we're still `starting`; clear it on any
  // other state (`live`/`error`/`stopped`/`idle`) so a normal start never trips.
  if (s.state === 'starting') armStartWatchdog(slot);
  else clearStartWatchdog(slot);
  // Fire on the running→stopped edge only (once per stream session, per slot).
  if (wasRunning[slot] && !s.running) {
    wasRunning[slot] = false;
    notifyBackendStopped(slot);
  } else if (s.running) {
    wasRunning[slot] = true;
  }
  // Sidecar aborted because the capture source changed size (game switched to
  // fullscreen 4:3 etc.) → restart the stream automatically instead of leaving
  // the streamer on an error they can only fix by clicking Start again.
  // Lazy import: state.svelte is imported everywhere, autoRestart pulls in the
  // chat API — same cycle-avoidance pattern as notifyBackendStopped above.
  if (ev.ev === 'error' && ev.code === 'capture_size_changed') {
    void import('./autoRestart').then((mod) => mod.maybeAutoRestart(slot));
  }
  // Sidecar ended the stream on its own because the shared window was closed
  // (game quit). The slot state is already reset by the `stopped` handler —
  // this only tells the streamer WHY, so the end doesn't look like a glitch.
  if (ev.ev === 'stopped' && ev.reason === 'source_closed') {
    toast.info(m.stream_stopped_source_closed());
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
