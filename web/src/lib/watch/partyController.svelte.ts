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
  LIVE_BACKOFF_S,
  LiveDetector,
  shouldResyncOnForeground,
  startHeartbeat,
  type CaptionTrack,
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
  #pending:
    | { action: 'play' | 'pause' | 'seek'; position: number; epoch?: number }
    | undefined;
  #broadcastTimer: number | undefined;
  /** True while the window/tab is hidden. Drift correction is suspended in this
   * state — the browser freezes background media, so seeking the player every
   * heartbeat only queues a stutter burst for when we return. */
  #hidden = false;
  /** Host-side live detection (YouTube). Fed from the heartbeat tick; once it
   * verdicts "live" we back the party off the live edge ONCE. See
   * {@link #maybeDetectLive}. */
  #liveDetector = new LiveDetector();
  #liveBackoffDone = false;

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
    // A source change (or handoff) remounts the player; the running heartbeat
    // closure still holds the destroyed OLD handle and would keep reporting the
    // previous clip's time. Drop it so the syncHeartbeat() that handleReady
    // fires right after this rebinds the heartbeat to THIS player.
    this.#stopHeartbeat?.();
    this.#stopHeartbeat = undefined;
    // A freshly mounted HOST player loads at the source's start_seconds (the
    // YT `start` var / video currentTime), NOT at the party's live position.
    // The host is the authority and is never drift-corrected, so without
    // seeding it here its first heartbeat broadcasts that start offset and
    // snaps every viewer back to the beginning. That is the "stream restarts
    // when the host detaches the window" bug: the popup is a fresh window with
    // a fresh player that takes over as host, and a handoff to a just-mounted
    // tile hits the same path. Viewers already self-seed via syncViewer's
    // no-prev hard sync; do the equivalent for the host. For a brand-new party
    // expected ≈ start_seconds, so this is a no-op.
    if (this.getIsHost() && !this.getIsPassive()) {
      const cur = this.getParty();
      this.#prevParty = cur;
      this.#syncHard(handle, cur);
    }
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

  /** Stop the host heartbeat immediately — call the instant the source starts
   * swapping (before the player remounts), so no beat measured against the old,
   * about-to-be-destroyed player can slip through with the NEW epoch during the
   * async new-player load. The next player's handleReady → onReady → syncHeartbeat
   * rebinds it to the fresh player. No-op for viewers (they never heartbeat). */
  suspendHeartbeat(): void {
    this.#stopHeartbeat?.();
    this.#stopHeartbeat = undefined;
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
    this.#stopHeartbeat = startHeartbeat((pos) => {
      const party = this.getParty();
      // Tag the beat with the source epoch it was measured against — the server
      // drops it if the clip was swapped in the meantime (stale-source guard).
      gateway.sendWatchHeartbeat(this.getChannelId(), party.party_id, pos, party.source_epoch);
      this.#maybeDetectLive();
    }, p);
  }

  /** Host-side live detection, piggybacked on the heartbeat tick (no extra
   * timer). A YouTube live stream synced like a VOD hard-seeks viewers to a
   * position at/after the live edge; that seek clamps to the edge and re-drifts
   * → the "stutter loop" (worst for whoever lags furthest behind the live
   * edge). Once we verdict "live" we back the whole party off the edge ONCE so
   * everyone sits in buffered DVR territory where drift correction works.
   * YouTube only — Twitch live is already passive, native is always a VOD. */
  #maybeDetectLive(): void {
    if (this.#liveBackoffDone || this.#liveDetector.verdict === false) return;
    if (this.getParty().source.type !== 'youtube') return;
    const p = this.#player;
    if (!p) return;
    if (this.#liveDetector.sample(p.getDuration(), Date.now()) === true) {
      this.#liveBackoffDone = true;
      this.backToBuffer();
    }
  }

  /** Pull the party back off the live edge into buffered DVR territory: the
   * host seeks back `seconds` and broadcasts it, and every viewer follows via
   * the heartbeat/positionJumped path. Fired automatically once on live
   * detection and manually from the tile's rewind button when a viewer's
   * buffer can't keep up at the live edge. No-op for non-host / passive. */
  backToBuffer(seconds = LIVE_BACKOFF_S): void {
    const p = this.#player;
    if (!p || !this.getIsHost() || this.getIsPassive()) return;
    const target = Math.max(0, p.getCurrentTime() - seconds);
    p.seek(target);
    const party = this.getParty();
    gateway.sendWatchControl(
      this.getChannelId(), party.party_id, 'seek', target, party.source_epoch
    );
  }

  onEvent(e: PlayerEvent): void {
    if (this.getIsHost()) {
      if (this.getIsPassive()) return;
      if (e.type === 'play') this.#scheduleBroadcast('play', e.position);
      else if (e.type === 'pause') this.#scheduleBroadcast('pause', e.position);
      else if (e.type === 'seek') this.#scheduleBroadcast('seek', e.position);
      else if (e.type === 'ended') {
        // Video zu Ende: das nächste Warteschlangen-Video nachrücken. Ist die
        // Schlange leer, bleibt die Party stehen (Server antwortet EMPTY).
        gateway.watchQueueAdvance(this.getChannelId(), this.getParty().party_id);
      }
      return;
    }
    if (this.getIsPassive()) return;
    // Update #viewerPaused unconditionally so the viewer's intent is never lost,
    // even inside the quiet window that follows a hard sync.
    if (e.type === 'pause') this.#viewerPaused = true;
    else if (e.type === 'play') this.#viewerPaused = false;
    // The quiet window only suppresses triggering another #syncHard (avoids a
    // feedback loop right after applyHard already snapped the player).
    const now = Date.now();
    if ((e.type === 'play' || e.type === 'pause') && now < this.#syncingUntil) return;
    if (e.type === 'play' && this.#player) this.#syncHard(this.#player, this.getParty());
  }

  /** Lautstärke 0–100 direkt am Player setzen. Für das Viewer-Volume-Control
   * im Tile: der read-only Player (controls:0) hat keinen nativen Regler mehr,
   * also reicht die Kachel die Lautstärke hierüber durch. No-op vor onReady. */
  setVolume(percent: number): void {
    this.#player?.setVolume(Math.max(0, Math.min(100, percent)));
  }

  /** Lautstärke, die der Player WIRKLICH ausspielt (0–100), oder null, solange
   * er das nicht sagen kann. Die Kachel richtet ihren Regler danach aus, statt
   * einen Startwert anzunehmen — siehe PlayerHandle.getVolume. */
  getVolume(): number | null {
    const v = this.#player?.getVolume?.();
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
  }

  /** Stummschaltung des Players — ein von der Lautstärke GETRENNTER Zustand.
   * null, solange der Player nichts dazu sagt. */
  isMuted(): boolean | null {
    const m = this.#player?.isMuted?.();
    return typeof m === 'boolean' ? m : null;
  }

  /** Stummschalten/aufheben, ohne die Lautstärke anzufassen. */
  setMuted(muted: boolean): void {
    this.#player?.setMuted?.(muted);
  }

  /** Ist die Untertitel-Steuerung des Players einsatzbereit? Vorher sagen die
   * drei Getter unten nichts aus. Wie beim Volume-Control gilt: der read-only
   * Zuschauer-Player (controls:0) hat keinen nativen CC-Knopf mehr, also reicht
   * die Kachel das hierüber durch. */
  isAvailable(): boolean {
    return this.#player?.hasCaptionSupport?.() ?? false;
  }

  /** Untertitel-Spuren des laufenden Videos. Kann leer sein, WÄHREND
   * Untertitel laufen — YouTube listet automatisch erzeugte nicht auf. */
  getCaptionTracks(): CaptionTrack[] {
    return this.#player?.getCaptionTracks?.() ?? [];
  }

  /** Sprachcode der aktiven Spur, oder null wenn Untertitel aus sind. */
  getActiveCaptionTrack(): string | null {
    return this.#player?.getActiveCaptionTrack?.() ?? null;
  }

  /** Spur per Sprachcode aktivieren; null schaltet Untertitel ab. Rein lokal —
   * bewusst NICHT synchronisiert: jeder Zuschauer entscheidet für sich. */
  setCaptionTrack(languageCode: string | null): void {
    this.#player?.setCaptionTrack?.(languageCode);
  }

  /** Aktuell gelieferte Auflösung des Players (Roh-Code) oder null. Rein zum
   *  Anzeigen im Qualitäts-Badge — jeder Zuschauer hat seinen eigenen Stream,
   *  der Wert ist also rein lokal und nicht synchronisiert. */
  getPlaybackQuality(): string | null {
    return this.#player?.getPlaybackQuality?.() ?? null;
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
    // Capture the epoch NOW (at the event), not at fire time — the debounced
    // send must carry the epoch of the clip the action was performed on, even
    // if a source swap slips in during the debounce window.
    this.#pending = { action, position, epoch: this.getParty().source_epoch };
    if (this.#broadcastTimer !== undefined) clearTimeout(this.#broadcastTimer);
    this.#broadcastTimer = window.setTimeout(() => {
      if (this.#pending) {
        gateway.sendWatchControl(
          this.getChannelId(),
          this.getParty().party_id,
          this.#pending.action,
          this.#pending.position,
          this.#pending.epoch
        );
        this.#pending = undefined;
      }
      this.#broadcastTimer = undefined;
    }, BROADCAST_DEBOUNCE_MS);
  }
}
