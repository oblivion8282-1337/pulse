/**
 * Watch-party sync primitives.
 *
 * The PlayerHandle interface is what each player wrapper exposes; the
 * WatchPartyTile drives both host (broadcast user actions) and viewer (apply
 * remote state) sides through these primitives.
 *
 * Two correction modes:
 *  - {@link DriftCorrector.applyHard} — used on host-driven transitions
 *    (play/pause toggled, explicit seek). Forces is_playing AND position.
 *  - {@link DriftCorrector.applySoft} — used on heartbeats. Drift-corrects
 *    position only, never calls play/pause. This lets viewers pause
 *    locally (e.g. to grab a drink) without being forced back to playing
 *    on the next heartbeat.
 *
 * Position correction policy (both modes):
 *  - |drift| < 0.1s  → ignore (within noise of getCurrentTime())
 *  - |drift| < 0.5s  → playbackRate nudge for 2s (1.05 or 0.95) so the
 *                       player catches up smoothly. Reset on cleanup or on
 *                       the next correction call.
 *  - |drift| ≥ 0.5s  → hard seek; this is jarring but the alternative
 *                       (slow drift) is worse.
 */

import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';

export type PlayerEvent =
  | { type: 'ready' }
  | { type: 'play'; position: number }
  | { type: 'pause'; position: number }
  | { type: 'seek'; position: number }
  | { type: 'error'; reason: string };

export interface PlayerHandle {
  play(): void;
  pause(): void;
  seek(position: number): void;
  getCurrentTime(): number;
  /** Optional — Twitch's Embed API doesn't expose this. Implementations
   * that can't honour it should make this a no-op. */
  setPlaybackRate(rate: number): void;
  /** Set output volume, 0-100. Each player normalises internally. */
  setVolume(percent: number): void;
  destroy(): void;
}

const DRIFT_IGNORE_S = 0.1;
const DRIFT_NUDGE_S = 0.5;
const NUDGE_RATE_FAST = 1.05;
const NUDGE_RATE_SLOW = 0.95;
const NUDGE_DURATION_MS = 2000;

/** Where the host's clock says we should be right now. */
export function expectedPosition(state: WatchPartyState, nowMs = Date.now()): number {
  if (!state.is_playing) return state.position;
  const elapsed = Math.max(0, (nowMs - state.updated_at) / 1000);
  return state.position + elapsed;
}

export type DriftAction = 'none' | 'nudge-up' | 'nudge-down' | 'seek';

/** Holds the transient playbackRate-nudge timer so we can reset it on the
 * next correction or on cleanup. One instance per player. */
export class DriftCorrector {
  private rateResetTimer: number | null = null;

  /** Force the player into the remote state — play/pause AND position.
   * Use on host-driven transitions (play/pause toggled, explicit seek by
   * host, viewer joining a party in progress). */
  applyHard(player: PlayerHandle, state: WatchPartyState): DriftAction {
    if (state.is_playing) player.play();
    else player.pause();
    return this.correctPosition(player, state);
  }

  /** Drift-correct position only. Does NOT call play/pause; if the viewer
   * paused locally and is_playing is true on the host, the player stays
   * paused — the next host-driven transition (or a manual viewer play) will
   * resync via {@link applyHard}. Returns 'none' if the host is paused
   * (nothing to drift against). */
  applySoft(player: PlayerHandle, state: WatchPartyState): DriftAction {
    if (!state.is_playing) return 'none';
    return this.correctPosition(player, state);
  }

  private correctPosition(player: PlayerHandle, state: WatchPartyState): DriftAction {
    const expected = expectedPosition(state);
    const actual = player.getCurrentTime();
    const drift = expected - actual;
    const abs = Math.abs(drift);
    if (abs < DRIFT_IGNORE_S) return 'none';
    if (abs < DRIFT_NUDGE_S && state.is_playing) {
      const rate = drift > 0 ? NUDGE_RATE_FAST : NUDGE_RATE_SLOW;
      this.nudge(player, rate);
      return drift > 0 ? 'nudge-up' : 'nudge-down';
    }
    this.cancelNudge(player);
    // eslint-disable-next-line no-console
    console.log('[wp] SEEK', {
      from: actual.toFixed(2),
      to: expected.toFixed(2),
      drift: drift.toFixed(2),
      direction: drift > 0 ? 'forward' : 'backward'
    });
    player.seek(expected);
    return 'seek';
  }

  private nudge(player: PlayerHandle, rate: number): void {
    player.setPlaybackRate(rate);
    if (this.rateResetTimer !== null) clearTimeout(this.rateResetTimer);
    this.rateResetTimer = window.setTimeout(() => {
      player.setPlaybackRate(1.0);
      this.rateResetTimer = null;
    }, NUDGE_DURATION_MS);
  }

  private cancelNudge(player: PlayerHandle): void {
    if (this.rateResetTimer !== null) {
      clearTimeout(this.rateResetTimer);
      this.rateResetTimer = null;
      player.setPlaybackRate(1.0);
    }
  }

  dispose(player: PlayerHandle): void {
    this.cancelNudge(player);
  }
}

/** Host-side: emit a heartbeat every `intervalMs` while playing. Returns a
 * stop function — call it on unmount or when the host hands off control. */
export function startHeartbeat(
  send: (position: number) => void,
  player: PlayerHandle,
  intervalMs = 3000
): () => void {
  const id = window.setInterval(() => {
    try {
      send(player.getCurrentTime());
    } catch {
      // Best-effort; ignore transient player errors.
    }
  }, intervalMs);
  return () => window.clearInterval(id);
}
