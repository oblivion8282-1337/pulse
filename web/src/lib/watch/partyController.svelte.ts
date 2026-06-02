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

  constructor(
    private getChannelId: () => string,
    private getParty: () => WatchPartyState,
    private getIsHost: () => boolean,
    private getIsPassive: () => boolean
  ) {}

  onReady(handle: PlayerHandle): void {
    this.#player = handle;
  }

  /** Drive from a $effect so it re-runs when `party` changes. Aligns the
   * player to the remote state: host-driven transition → applyHard, plain
   * heartbeat → applySoft (never override the viewer's local pause). */
  syncViewer(): void {
    const p = this.#player;
    if (!p || this.getIsHost() || this.getIsPassive()) return;
    const cur = this.getParty();
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
    const p = this.#player;
    if (!p || !this.getIsHost() || this.getIsPassive()) {
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
