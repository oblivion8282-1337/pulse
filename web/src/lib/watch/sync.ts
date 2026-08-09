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
import { clockSync } from '$lib/watch/clockSync';

export type PlayerEvent =
  | { type: 'ready' }
  | { type: 'play'; position: number }
  | { type: 'pause'; position: number }
  | { type: 'seek'; position: number }
  // Video reached its end — the host promotes the next queued item.
  | { type: 'ended' }
  // The player's caption support appeared or changed (YouTube: onApiChange).
  // The tile re-reads the track list and shows/hides its CC control.
  | { type: 'captions_changed' }
  // YouTube's adaptive bitrate switched the delivered resolution — the tile
  // re-reads it for its quality badge. Read-only display; there is no setter
  // (setPlaybackQuality is deprecated and would only be an empty promise).
  | { type: 'quality_changed' }
  | { type: 'error'; reason: string };

/** One selectable subtitle/caption track of the current media. */
export interface CaptionTrack {
  /** Language code as the player reports it ('de', 'en', 'en-US', …). */
  languageCode: string;
  /** Human-readable name from the player ('Deutsch', 'English (auto)'). */
  label: string;
}

export interface PlayerHandle {
  play(): void;
  pause(): void;
  seek(position: number): void;
  getCurrentTime(): number;
  /** Total media duration in seconds. For a YouTube LIVE event this returns
   * the elapsed time since the stream began — it GROWS ~1s/s — which is what
   * {@link LiveDetector} keys off. VOD/native return a constant; players with
   * no meaningful duration (Twitch) return 0. */
  getDuration(): number;
  /** Optional — Twitch's Embed API doesn't expose this. Implementations
   * that can't honour it should make this a no-op. */
  setPlaybackRate(rate: number): void;
  /** Set output volume, 0-100. Each player normalises internally. */
  setVolume(percent: number): void;
  /** Selectable subtitle tracks, empty when the player has none (yet).
   *
   * The three caption methods are OPTIONAL: only a player that both exposes a
   * caption API and hides its native control bar needs them (today: YouTube in
   * viewer mode). Native `<video>` and Twitch keep their own chrome, so their
   * viewers already have a CC button and these stay unimplemented — the tile
   * renders no caption control when `getCaptionTracks` is absent. */
  hasCaptionSupport?(): boolean;
  /** Selectable tracks. May be EMPTY while captions are running: YouTube omits
   * auto-generated ones here — see youtubeCaptions.ts. */
  getCaptionTracks?(): CaptionTrack[];
  /** Language code of the active track, or null when captions are off. Only
   * trustworthy before the first {@link setCaptionTrack} — see CaptionsState. */
  getActiveCaptionTrack?(): string | null;
  /** Activate a track by language code; null turns captions off. */
  setCaptionTrack?(languageCode: string | null): void;
  /** Aktuelle Wiedergabe-Auflösung als Roh-Code ('hd1080', 'medium', 'auto', …),
   *  oder null wenn unbekannt. OPTIONAL — nur YouTube implementiert das heute.
   *  Liefert den WERT, den der Player gerade ausspielt (Adaptive Bitrate), nicht
   *  einen Wunsch — deshalb verlässlich, anders als der deaktivierte Setter. */
  getPlaybackQuality?(): string | null;
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

/** Where the host's clock says we should be right now.
 *
 * `nowMs` defaults to the *calibrated server clock* ({@link clockSync.now}),
 * NOT raw `Date.now()` — `state.updated_at` is a server timestamp, so mixing
 * in a skewed local clock would offset every viewer by their clock error.
 * Callers comparing two server timestamps (e.g. `expectedPosition(prev,
 * cur.updated_at)`) pass `nowMs` explicitly and stay on the raw server axis. */
export function expectedPosition(state: WatchPartyState, nowMs = clockSync.now()): number {
  if (!state.is_playing) return state.position;
  const elapsed = Math.max(0, (nowMs - state.updated_at) / 1000);
  return state.position + elapsed;
}

/** Gap thresholds for {@link hostPlaybackStalled}. */
// Must sit below the ~1s heartbeat cadence (see startHeartbeat) — at 1.5 the
// guard would never engage at 1s spacing, re-exposing the minimized-host
// stutter loop it exists to prevent. 0.8 still clears normal jitter (a playing
// host advances ~1s/beat → posDelta ≈ wallDelta, never reads as stalled).
const STALL_MIN_GAP_S = 0.8;
const STALL_ADVANCE_RATIO = 0.5;
const STALL_BACKSTEP_TOLERANCE_S = 1.0;

/** True when the host is nominally playing but its position barely moved
 * against wall-clock between two heartbeats — i.e. the host's media pipeline
 * is throttled/frozen (window minimized or occluded) while is_playing stays
 * true.
 *
 * Signature: `is_playing` on both frames, a real wall-clock gap, and the
 * position advanced far less than that gap WITHOUT being a deliberate
 * backward seek (which shows a large negative delta and must still resync via
 * the hard path). Catching this lets the viewer skip drift correction instead
 * of hard-seeking backward to the frozen position every ~2s — the loop a
 * backgrounded host otherwise triggers. */
export function hostPlaybackStalled(prev: WatchPartyState, cur: WatchPartyState): boolean {
  if (!prev.is_playing || !cur.is_playing) return false;
  const wallDelta = (cur.updated_at - prev.updated_at) / 1000;
  if (wallDelta < STALL_MIN_GAP_S) return false;
  const posDelta = cur.position - prev.position;
  return posDelta > -STALL_BACKSTEP_TOLERANCE_S && posDelta < wallDelta * STALL_ADVANCE_RATIO;
}

/** Decide what a viewer should do when the window returns to the foreground
 * after having been hidden.
 *
 * While the window is hidden the browser (and every mobile WebView) freezes /
 * pauses background `<video>` playback, so the player's clock stops while the
 * host's `expected` position keeps advancing with wall-clock. Drift correction
 * is therefore SUSPENDED while hidden (see PartyController.syncViewer) — running
 * it would seek a frozen player on every heartbeat and queue a backlog that
 * fires as a fast-forward stutter burst the moment we come back, the "minimize →
 * highspeed catch-up → loop" bug.
 *
 * On return we instead do exactly ONE hard resync to the host's current
 * position — UNLESS this client is the host (it's the authority, never
 * corrected), the source is passive (Twitch live: no seekable position), or the
 * viewer had paused locally (respect their pause; they resync on manual play).
 */
export function shouldResyncOnForeground(opts: {
  isHost: boolean;
  isPassive: boolean;
  viewerPaused: boolean;
}): boolean {
  return !opts.isHost && !opts.isPassive && !opts.viewerPaused;
}

/** Minimum wall-clock gap between two duration samples before the delta is
 * trustworthy. Heartbeats are ~1s apart; 0.8 reliably clears one beat of
 * scheduler jitter. */
const LIVE_SAMPLE_MIN_GAP_S = 0.8;
/** A live event's getDuration() grows ~1s per wall second; a VOD's is flat.
 * Live iff the duration grew by more than half the elapsed wall time — well
 * clear of either case, no false positives from jitter. */
const LIVE_GROWTH_RATIO = 0.5;
/** How far behind the live edge the host backs the party off so everyone sits
 * in buffered DVR territory instead of fighting the un-seekable live edge.
 * See {@link PlayerHandle.getDuration} and PartyController.backToBuffer. */
export const LIVE_BACKOFF_S = 30;

/** Detects a YouTube live broadcast from getDuration() growth across two
 * samples. Per the IFrame API docs, getDuration() on a live event returns the
 * elapsed time since the stream began (so it GROWS even while locally paused);
 * on a VOD it is constant. The API exposes no direct live flag, so growth is
 * the only signal. One verdict per instance — once decided it sticks. Pure +
 * injectable (caller passes the wall clock) so it's testable without a player. */
export class LiveDetector {
  #first: { dur: number; atMs: number } | undefined;
  #verdict: boolean | null = null;

  /** Fold one (duration-seconds, wall-ms) sample in. Returns the verdict once
   * decided (true = live, false = VOD), else null while more samples are
   * needed. Samples with a non-positive duration (metadata not loaded yet) are
   * ignored. */
  sample(durationS: number, atMs: number): boolean | null {
    if (this.#verdict !== null) return this.#verdict;
    if (!Number.isFinite(durationS) || durationS <= 0) return null;
    if (!this.#first || durationS < this.#first.dur) {
      // (Re)seed the baseline. A duration that went BACKWARDS means the first
      // sample was stale (fresh player object / API jitter) — a live counter
      // only ever grows — so restart instead of mis-verdicting it as VOD.
      this.#first = { dur: durationS, atMs };
      return null;
    }
    const wallDelta = (atMs - this.#first.atMs) / 1000;
    if (wallDelta < LIVE_SAMPLE_MIN_GAP_S) return null;
    const durDelta = durationS - this.#first.dur;
    this.#verdict = durDelta > wallDelta * LIVE_GROWTH_RATIO;
    return this.#verdict;
  }

  get verdict(): boolean | null {
    return this.#verdict;
  }
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
 * stop function — call it on unmount or when the host hands off control.
 *
 * 1s cadence (matches watchparty.me's CMD:ts): the host's position is the
 * single authority and YouTube fires no seek event, so a host scrub only
 * reaches viewers via this heartbeat. At 3s a backward jump was masked by
 * forward playback within the window and landed in the nudge band; at 1s the
 * viewer's positionJumped check catches it and hard-seeks within ~1s. The
 * backend debounce (`_HEARTBEAT_DEBOUNCE_MS`) must stay below this interval or
 * it drops every other beat — keep the two in sync. */
export function startHeartbeat(
  send: (position: number) => void,
  player: PlayerHandle,
  intervalMs = 1000
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
