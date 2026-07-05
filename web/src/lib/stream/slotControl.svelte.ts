/**
 * Shared HQ-stream slot control — the "which slots are running / pick the next
 * free one / stop one or all" logic used by BOTH the streamer's status bar
 * (`StreamStatusBar`) and the rocket split-button (`ScreenShareModeButton`).
 * Previously duplicated verbatim in both components.
 *
 * `nextFreeStreamSlot` reads `runningStreamSlots()` (a `$state` lookup), so call
 * it inside a `$derived` for reactivity.
 */
import { runningStreamSlots, MAX_STREAM_SLOTS } from './state.svelte';
import { gsr } from './gsr';

/** Lowest free slot for a new stream (0..MAX-1), or -1 when all are in use. */
export function nextFreeStreamSlot(): number {
  const running = runningStreamSlots();
  for (let i = 0; i < MAX_STREAM_SLOTS; i++) if (!running.includes(i)) return i;
  return -1;
}

/** Stop one slot's stream. Best-effort — the WS broadcast restores state. */
export async function stopSlot(slot: number): Promise<void> {
  try {
    await gsr.stop(slot);
  } catch {
    /* WS-Broadcast holt den State eh nach */
  }
}

/** Stop every currently-running slot. */
export async function stopAll(): Promise<void> {
  for (const slot of runningStreamSlots()) await stopSlot(slot);
}
