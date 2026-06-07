/**
 * Watch-party host/viewer sync orchestration, extracted from WatchPartyTile so
 * the component stays under the 250-line cap. Behaviour is unchanged — this is
 * a pure move of the two $effects + broadcast debounce + heartbeat wiring.
 *
 * Construct one per mounted tile, call onReady/onEvent from the player, and
 * dispose() on destroy. The component drives syncViewer()/syncHeartbeat() from
 * $effects so they re-run when the reactive `party` changes.
 */
import { gateway } from '$lib/ws/connection';
import {
  DriftCorrector,
  expectedPosition,
  hostPlaybackStalled,
  shouldResyncOnForeground,
  startHeartbeat,
  type PlayerEvent,
  type PlayerHandle
} from '$lib/watch/sync';
import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';

const SEEK_DETECTION_THRESHOLD_S = 2.0;
const SYNC_QUIET_MS = 2000;
const BROADCAST_DEBOUNCE_MS = 300;

export class PartyController {
  #player: PlayerHandle | undefined;
  #corrector = new DriftCorrector();
  #prevParty: WatchPartyState | undefined;
  #viewerPaused = false;
  #syncingUntil = 0;
  #stopHeartbeat: (() => void) | undefined;
  #pending: { action: 'play' | 'pause' | 'seek'; position: number } | undefined;
  #broadcastTimer: number | undefined;
  /** True while the window/tab is hidden. Drift correction is suspended in this
   * state — the browser freezes background media, so seeking the player every
   * heartbeat only queues a stutter burst for when we return. */
  #hidden = false;

  constructor(
    private getChannelId: () => string,
    private getParty: () => WatchPartyState,
    private getIsHost: () => boolean,
    private getIsPassive: () => boolean
  ) {
    if (typeof document !== 'undefined') {
      this.#hidden = document.visibilityState === 'hidden';
      document.addEventListener('visibilitychange', this.#onVisibility);
    }
  }

  /** Stable ref (add/removeEventListener). Suspends correction while hidden and
   * does ONE clean hard resync on return — see {@link shouldResyncOnForeground}
   * for the full rationale. This is the fix for the "minimize → video freezes →
   * fast-forwards through the lost time → stuck in a catch-up loop" report:
   * without it, each host heartbeat that arrives while we're hidden hard-seeks a
   * frozen player, and the backlog plays out as a seek storm on return. */
  #onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    const p = this.#player;
    if (hidden) {
      // Drop any in-flight playbackRate nudge so we don't come back stuck at
      // 1.05x (its reset setTimeout is unreliable under background throttling).
      if (p) this.#corrector.dispose(p);
      return;
    }
    // Foreground again: the player was frozen while `expected` ran on, so we're
    // far behind. Snap once instead of letting the per-heartbeat correction
    // backlog fire. Host / passive / locally-paused viewers are left untouched.
    if (
      !p ||
      !shouldResyncOnForeground({
        isHost: this.getIsHost(),
        isPassive: this.getIsPassive(),
        viewerPaused: this.#viewerPaused
      })
    )
      return;
    const cur = this.getParty();
    this.#prevParty = cur; // re-anchor so the next heartbeat reads as continuous
    this.#syncHard(p, cur);
  };

  onReady(handle: PlayerHandle): void {
    this.#player = handle;
  }

  /** Drive from a $effect so it re-runs when `party` changes. Aligns the
   * player to the remote state: host-driven transition → applyHard, plain
   * heartbeat → applySoft (never override the viewer's local pause). */
  syncViewer(): void {
    // Read the reactive getters FIRST so this method (driven from a $effect)
    // always registers party/isHost/isPassive as dependencies. If the `!p`
    // player guard short-circuits ahead of them, an effect whose first run
    // happens before the player's async onReady captures NO reactive deps and
    // never re-runs — the viewer then stops drift-correcting and won't follow
    // a host backward seek. (handleReady kicks the first run once ready.)
    const cur = this.getParty();
    const isHost = this.getIsHost();
    const isPassive = this.getIsPassive();
    const p = this.#player;
    if (!p || isHost || isPassive) return;
    // Window hidden: the browser has frozen/paused the player. Correcting now
    // seeks a frozen player on every heartbeat and queues a backlog that fires
    // as a fast-forward stutter burst on return. Suspend until #onVisibility
    // does a single clean resync. Do NOT advance #prevParty — the resync
    // re-anchors it, so detection stays continuous across the hidden gap.
    if (this.#hidden) return;
    const prev = this.#prevParty;
    this.#prevParty = cur;
    if (!prev) {
      this.#viewerPaused = !cur.is_playing;
      this.#syncHard(p, cur);
      return;
    }
    // Host minimized/occluded: its throttled media keeps is_playing=true but
    // its position barely advances, so cur.position lands far below where
    // wall-clock says the host should be. Without this guard that reads as a
    // backward "seek" and the corrector hard-seeks the viewer back every
    // ~2s — a stutter loop. Skip correction until the host resumes advancing.
    if (hostPlaybackStalled(prev, cur)) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log('[wp] host stalled — skip drift correction', {
          posDelta: (cur.position - prev.position).toFixed(2),
          wallDelta: ((cur.updated_at - prev.updated_at) / 1000).toFixed(2)
        });
      }
      return;
    }
    const playingFlipped = prev.is_playing !== cur.is_playing;
    // Server-vs-server compare (both timestamps are server-stamped): pass
    // cur.updated_at explicitly so this stays on the raw server axis. Do NOT
    // let it fall back to the clock-calibrated default — there is no client
    // clock involved here, so calibration would be wrong.
    const expectedFromPrev = expectedPosition(prev, cur.updated_at);
    const positionJumped =
      Math.abs(cur.position - expectedFromPrev) > SEEK_DETECTION_THRESHOLD_S;
    if (playingFlipped || positionJumped) {
      this.#viewerPaused = !cur.is_playing;
      this.#syncHard(p, cur);
      return;
    }
    if (!this.#viewerPaused) this.#syncSoft(p, cur);
  }

  /** Drive from a $effect: starts/stops the host heartbeat based on role. */
  syncHeartbeat(): void {
    // Reactive getters first (same reason as syncViewer): the effect must keep
    // tracking isHost/isPassive so a handoff that flips the role re-runs this
    // and stops the heartbeat. The initial start is kicked from handleReady.
    const isHost = this.getIsHost();
    const isPassive = this.getIsPassive();
    const p = this.#player;
    if (!p || !isHost || isPassive) {
      this.#stopHeartbeat?.();
      this.#stopHeartbeat = undefined;
      return;
    }
    if (this.#stopHeartbeat) return;
    this.#stopHeartbeat = startHeartbeat(
      (pos) => gateway.sendWatchHeartbeat(this.getChannelId(), pos),
      p
    );
  }

  onEvent(e: PlayerEvent): void {
    if (this.getIsHost()) {
      if (this.getIsPassive()) return;
      if (e.type === 'play') this.#scheduleBroadcast('play', e.position);
      else if (e.type === 'pause') this.#scheduleBroadcast('pause', e.position);
      else if (e.type === 'seek') this.#scheduleBroadcast('seek', e.position);
      return;
    }
    if (this.getIsPassive()) return;
    const now = Date.now();
    if ((e.type === 'play' || e.type === 'pause') && now < this.#syncingUntil) return;
    if (e.type === 'pause') this.#viewerPaused = true;
    else if (e.type === 'play') {
      this.#viewerPaused = false;
      if (this.#player) this.#syncHard(this.#player, this.getParty());
    }
  }

  dispose(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibility);
    }
    this.#stopHeartbeat?.();
    if (this.#broadcastTimer !== undefined) clearTimeout(this.#broadcastTimer);
    if (this.#player) this.#corrector.dispose(this.#player);
    this.#player?.destroy();
  }

  #syncHard(p: PlayerHandle, s: WatchPartyState): void {
    const action = this.#corrector.applyHard(p, s);
    if (action !== 'none') this.#syncingUntil = Date.now() + SYNC_QUIET_MS;
  }
  #syncSoft(p: PlayerHandle, s: WatchPartyState): void {
    const action = this.#corrector.applySoft(p, s);
    if (action !== 'none') this.#syncingUntil = Date.now() + SYNC_QUIET_MS;
  }
  #scheduleBroadcast(action: 'play' | 'pause' | 'seek', position: number): void {
    this.#pending = { action, position };
    if (this.#broadcastTimer !== undefined) clearTimeout(this.#broadcastTimer);
    this.#broadcastTimer = window.setTimeout(() => {
      if (this.#pending) {
        gateway.sendWatchControl(
          this.getChannelId(),
          this.#pending.action,
          this.#pending.position
        );
        this.#pending = undefined;
      }
      this.#broadcastTimer = undefined;
    }, BROADCAST_DEBOUNCE_MS);
  }
}
