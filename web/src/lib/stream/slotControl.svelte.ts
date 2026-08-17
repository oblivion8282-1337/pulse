/**
 * Shared HQ-stream slot control — the "which slots are running / pick the next
 * free one / stop one or all" logic used by BOTH the streamer's status bar
 * (`StreamStatusBar`) and the rocket split-button (`ScreenShareModeButton`).
 * Previously duplicated verbatim in both components.
 *
 * `nextFreeStreamSlot` reads `runningStreamSlots()` (a `$state` lookup), so call
 * it inside a `$derived` for reactivity.
 */
import { runningStreamSlots, MAX_STREAM_SLOTS, markStopped } from './state.svelte';
import { gsr } from './gsr';

/** Lowest free slot for a new stream (0..MAX-1), or -1 when all are in use. */
export function nextFreeStreamSlot(): number {
  const running = runningStreamSlots();
  for (let i = 0; i < MAX_STREAM_SLOTS; i++) if (!running.includes(i)) return i;
  return -1;
}

/** Stop one slot's stream. Best-effort — the WS broadcast restores state.
 *
 *  `grund` ist reine Diagnose: er reist im Befehl mit und steht damit in
 *  derselben Protokollzeile wie der Stopp (`sidecar-log-befehle.ts`). Nur die
 *  Wege, die einen Rechner von sich aus stoppen, füllen ihn — beim Knopf des
 *  Streamers ist „der Mensch hat geklickt" keine Frage, die je offen war. */
export async function stopSlot(slot: number, grund?: string): Promise<void> {
  try {
    await gsr.stop(slot, grund);
    // Reconcile locally: the fresh (respawned) sidecar emits no `stopped` event,
    // so without this a stop after a crash would leave the UI stuck on "live".
    markStopped(slot);
  } catch {
    /* WS-Broadcast holt den State eh nach */
  }
}

/** Stop every currently-running slot. Parallel, not one after another: each
 *  slot owns its own sidecar process, and under the Windows respawn-on-stop
 *  model a single `stop` can take seconds. Sequentially that added up per
 *  running stream while the user waited on one click. Same shape as the
 *  channel-leave path in `livekit.svelte.ts`; `stopSlot` swallows its own
 *  errors, so no rejection escapes. */
export async function stopAll(): Promise<void> {
  // Ausgeschriebene Lambda statt `map(stopSlot)`: `map` reicht den Index als
  // zweites Argument durch, und der landete seit `grund` in der Protokollzeile.
  await Promise.all(runningStreamSlots().map((slot) => stopSlot(slot)));
}
