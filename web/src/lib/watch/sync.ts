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
 *  - |drift| < 2.0s  → playbackRate nudge for 2s (1.05 or 0.95) so the
 *                       player catches up smoothly. Reset on cleanup or on
 *                       the next correction call.
 *  - |drift| ≥ 2.0s  → hard seek with SEEK_LEAD_S lookahead + nudge-along.
 *                       See "seek lead" block below.
 *
 * Why the wide nudge band: YouTube's seek costs 0.5–1.5s of real time
 * (BUFFERING → PLAYING). If every heartbeat above 0.5s drift triggers a
 * seek, the seek itself produces a new ~1s drift, which the next heartbeat
 * tries to fix with another seek — a 3s-cadence stutter loop. A wider
 * nudge band lets playbackRate smooth small drifts away without paying the
 * buffering cost.
 *
 * Seek-lead + nudge-along: when we hard-seek, the player freezes for ~1.5–
 * 3s while YT buffers. During the freeze, wall-clock advances but the
 * player doesn't — so a seek to `expected` lands the player back ~2s
 * BEHIND wall-clock the moment it resumes. We compensate two ways:
 *  1. Seek to `expected + SEEK_LEAD_S` (lookahead) so the player lands
 *     close to wall-clock once buffering finishes.
 *  2. Keep playbackRate=1.05 active for ~3s after the seek, so any
 *     residual lag (buffer longer than lead) gets nudged away instead of
 *     accumulating into a follow-up seek.
 * Observed in real logs: without lead, every hard seek produced a 2–3s
 * follow-up drift that re-triggered another seek every 3s — a "stutter
 * loop" that wouldn't break until something pushed drift below the
 * nudge band by accident.
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
const DRIFT_NUDGE_S = 2.0;
const NUDGE_RATE_FAST = 1.05;
const NUDGE_RATE_SLOW = 0.95;
const NUDGE_DURATION_MS = 2000;
/** Seconds added to the target position on a hard seek to compensate for
 * the buffer-induced wall-clock advance during YT's seek freeze. ~1.5s
 * matches typical YT buffer latency. See header comment. */
const SEEK_LEAD_S = 1.5;
/** How long to keep the post-seek "catch up" nudge active. Longer than
 * NUDGE_DURATION_MS because buffer recovery isn't instantaneous. */
const POST_SEEK_NUDGE_MS = 3000;

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
    // Seek to expected + lead so the player lands near wall-clock once
    // YT's buffer phase finishes (during which wall-clock advances but
    // the player is frozen). Then keep a 1.05x nudge active for a few
    // seconds to absorb any residual lag if the buffer outlasted the
    // lead. Do NOT cancelNudge here — the next nudge() call resets the
    // rate-reset timer cleanly, and an aggressive cancel would briefly
    // drop back to 1.0x before the seek lands, wasting the opportunity.
    // Only apply the seek lead when playing; when paused, seek to the
    // exact expected position without any lookahead.
    const target = expected + (state.is_playing ? SEEK_LEAD_S : 0);
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[wp] SEEK', {
        from: actual.toFixed(2),
        to: target.toFixed(2),
        expected: expected.toFixed(2),
        lead: SEEK_LEAD_S.toFixed(2),
        drift: drift.toFixed(2),
        direction: drift > 0 ? 'forward' : 'backward'
      });
    }
    player.seek(target);
    // Only apply post-seek nudge when playing; when paused, reset to 1.0x.
    if (state.is_playing) {
      this.nudge(player, NUDGE_RATE_FAST, POST_SEEK_NUDGE_MS);
    } else {
      this.cancelNudge(player);
    }
    return 'seek';
  }

  private nudge(player: PlayerHandle, rate: number, durationMs = NUDGE_DURATION_MS): void {
    player.setPlaybackRate(rate);
    if (this.rateResetTimer !== null) clearTimeout(this.rateResetTimer);
    this.rateResetTimer = window.setTimeout(() => {
      player.setPlaybackRate(1.0);
      this.rateResetTimer = null;
    }, durationMs);
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
