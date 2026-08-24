import type { RemoteAudioTrack } from 'livekit-client';
import { isMobile } from '$lib/platform/runtime';
import type { SpatialMode } from '$lib/stores/settings.svelte';
import { applySinkId } from '$lib/audio/applySinkId';
import type { SpatialLayout } from './spatial/layout';
import { loadResonance } from './spatial/resonanceLoader';
import { SpatialScene, resolveQuality } from './spatial/spatialScene';

interface AudioNodeBundle {
  /** Null on the mobile path — there the `<audio>` element is the audible
   *  source and no Web Audio graph is built. */
  source: MediaStreamAudioSourceNode | null;
  /** Null at default volume (path is `source → gain → destination`); spliced in
   *  lazily while a user is boosted >100 % and removed on reset. Mobile: always null. */
  compressor: DynamicsCompressorNode | null;
  /** Null on the mobile path (see `source`). */
  gain: GainNode | null;
  /** Null while the playback limiter is off. When on, sits at the tail
   *  (gain → limiter → destination) catching the final post-makeup level so a
   *  suddenly-shouting participant can't blow past your ears. Mobile: always null. */
  limiter: DynamicsCompressorNode | null;
  /** Desktop: muted <audio> that keeps Chromium's WebRTC decoder alive — without
   *  it MediaStreamAudioSourceNode emits nothing for RTCPeerConnection tracks
   *  (known Chromium bug). We never hear it; the audible path is
   *  source → [compressor →] gain → [limiter →] ctx.destination.
   *  Mobile: this element IS the audible path (unmuted) — see the class doc. */
  anchor: HTMLAudioElement;
  userId: string;
}

/**
 * Owns the playback routing for remote participant mic tracks (not screen-share
 * — those live in ScreenShareTile).
 *
 * **Desktop path (Web Audio graph).** Default is a 1:1 pass-through
 * `source → gain → destination`; a DynamicsCompressorNode is spliced in only
 * while a user is boosted >100 %, to catch the clipping linear gain would
 * otherwise produce. An optional brick-wall limiter can be spliced into the tail
 * via `setLimiterEnabled` to clamp suddenly-loud participants.
 *
 * Why not `<audio>` on desktop: `HTMLMediaElement.volume` is spec-clamped to
 * 0..1, so a per-user "louder than 100 %" slider had no way to work. A Web Audio
 * graph has no such ceiling.
 *
 * **Mobile path (`<audio>` element).** Android Chrome / iOS Safari / the TWA
 * suspend a *backgrounded* AudioContext within seconds of a screen lock, cutting
 * call audio. An unmuted media element survives as OS background media (paired
 * with a MediaSession — see `voice/mediaSession.ts`), so on mobile we skip the
 * Web Audio graph and play each track through its `<audio>` element. Trade-off:
 * volume is clamped to 0..1 (no >100 % boost) and no makeup gain is applied (the
 * +12 dB only compensated the Chromium level loss through
 * MediaStreamAudioSourceNode, which isn't in play here).
 */
export class RemoteAudioElements {
  /** Mobile devices play through the <audio> element; desktop uses Web Audio. */
  #mobile = isMobile();
  #ctx: AudioContext | null = null;
  #nodes = new Map<string, AudioNodeBundle>();
  /** Secondary index: userId → Set of track SIDs. Allows O(1) lookup in
   *  setUserVolume instead of a linear scan over all nodes. */
  #userSids = new Map<string, Set<string>>();
  /** Per-user gain factor. Authoritative copy lives in settings.voice.userVolumes; we mirror it here so attach() can pick up the value before settings has had a chance to push it. */
  #userVolumes = new Map<string, number>();
  /** Discord-tuned compressor, spliced in only while a user is boosted >100 %. */
  static readonly COMPRESSOR = {
    threshold: -20,
    knee: 10,
    ratio: 4,
    attack: 0.003,
    release: 0.25
  } as const;
  /** Peak limiter for the playback tail. Hard knee + max ratio = brick-wall:
   *  transparent on normal speech, clamps sudden loud bursts at the threshold.
   *  Fast attack so a shout is caught within a few ms; per-user toggle. */
  static readonly LIMITER = {
    threshold: -6,
    knee: 0,
    ratio: 20,
    attack: 0.003,
    release: 0.1
  } as const;
  /** Compensates for the Chromium-side level loss when WebRTC audio is routed
   *  through MediaStreamAudioSourceNode instead of direct HTMLAudioElement
   *  playback, plus the sender-side AGC being off while RNNoise is the active
   *  mic filter. UI "100 %" maps to a Web Audio gain of 4.0 (+12 dB). Desktop
   *  only — the mobile <audio> path plays at the track's natural level. */
  static readonly DEFAULT_MAKEUP_GAIN = 4.0;
  deafened = false;
  outputDeviceId = '';
  /** Whether the playback peak limiter is spliced into each node's tail. */
  #limiterEnabled = false;
  /** Master playback volume for ALL incoming voice (multiplies every per-user
   *  factor). 1.0 = unchanged. Device-local — set from settings.voice.outputVolume.
   *  On the mobile `<audio>` path the effective element volume is clamped to
   *  0..1, so a master >100 % can't boost there (only attenuate). */
  #masterVolume = 1;
  /** Persisted spatial-audio mode. `off` (and always on mobile) = flat mix —
   *  tails go straight to `ctx.destination`. Otherwise each tail is routed
   *  into the participant's Resonance source via `#spatial`. */
  #spatialMode: SpatialMode = 'off';
  /** Active binaural scene, or null when spatial audio is off / not yet loaded.
   *  Built lazily on first non-off mode (the vendored bundle is fetched then). */
  #spatial: SpatialScene | null = null;
  /** Guards against overlapping async (re)builds racing each other. */
  #spatialBuildToken = 0;
  /** Frontal-fan layout (total arc + shared distance) applied to the scene.
   *  Pushed from the UI; re-applied whenever the scene is (re)built. */
  #spatialLayout: SpatialLayout = { spreadDeg: 40, distanceM: 1 };

  #ensureContext(): AudioContext {
    if (this.#ctx && this.#ctx.state !== 'closed') return this.#ctx;
    if (this.#ctx?.state === 'closed') this.#ctx = null;
    const ctx = new AudioContext();
    if (this.outputDeviceId) void applySinkId(ctx, this.outputDeviceId);
    this.#ctx = ctx;
    return ctx;
  }

  /** Called when a remote audio track is subscribed. `onBlocked` fires if
   *  playback can't start (autoplay policy: a suspended AudioContext on desktop,
   *  or a rejected `<audio>.play()` on mobile). */
  attach(track: RemoteAudioTrack, userId: string, onBlocked: () => void): void {
    const sid = track.sid;
    if (!sid) return;
    if (this.#nodes.has(sid)) return;
    const mst = track.mediaStreamTrack;
    if (!mst) return;
    const stream = new MediaStream([mst]);

    const anchor = document.createElement('audio');
    anchor.autoplay = true;
    anchor.srcObject = stream;
    anchor.style.display = 'none';

    if (this.#mobile) {
      // The <audio> element IS the audible path — it survives a backgrounded
      // screen lock where an AudioContext would be suspended.
      anchor.muted = this.deafened;
      anchor.volume = this.#elementVolume(userId);
      if (this.outputDeviceId) void applySinkId(anchor, this.outputDeviceId);
      document.body.appendChild(anchor);
      const node: AudioNodeBundle = {
        source: null,
        compressor: null,
        gain: null,
        limiter: null,
        anchor,
        userId
      };
      this.#nodes.set(sid, node);
      this.#indexUser(userId, sid);
      const p = anchor.play();
      if (p) void p.catch(() => onBlocked());
      return;
    }

    // Desktop: muted anchor only keeps the WebRTC decoder running; the audible
    // path is the Web Audio graph below.
    anchor.muted = true;
    document.body.appendChild(anchor);
    void anchor.play().catch(() => undefined);

    const ctx = this.#ensureContext();
    this.#attachDesktopNode(ctx, sid, userId, stream, anchor);
    // First track while a non-off mode is pending: build the scene now that a
    // context exists (lazily fetches the engine, then reroutes every track).
    if (this.#spatialMode !== 'off' && !this.#spatial) void this.setSpatialMode(this.#spatialMode);

    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => { if (ctx.state !== 'running') onBlocked(); }).catch(() => onBlocked());
    }
  }

  detach(sid: string): void {
    const node = this.#nodes.get(sid);
    if (!node) return;
    this.#disconnectGraph(node);
    node.anchor.srcObject = null;
    node.anchor.remove();
    this.#nodes.delete(sid);
    // Remove from secondary index.
    const sids = this.#userSids.get(node.userId);
    if (sids) {
      sids.delete(sid);
      if (sids.size === 0) {
        this.#userSids.delete(node.userId);
        this.#spatial?.removeSource(node.userId);
      }
    }
  }

  setDeafened(on: boolean): void {
    this.deafened = on;
    if (this.#mobile) {
      for (const node of this.#nodes.values()) node.anchor.muted = on;
      return;
    }
    for (const node of this.#nodes.values()) this.#syncNode(node);
  }

  setUserVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(4, volume));
    if (clamped === 1) this.#userVolumes.delete(userId);
    else this.#userVolumes.set(userId, clamped);
    // Use the secondary index for O(k) lookup (k = tracks for this user, ≈1).
    const sids = this.#userSids.get(userId);
    if (sids) {
      for (const sid of sids) {
        const node = this.#nodes.get(sid);
        if (node) this.#refreshNode(node);
      }
    }
  }

  /** Set the master playback volume (0..2) for ALL incoming voice. Applies live
   *  to every current track and is picked up by future ones via attach(). On
   *  mobile a value >1.0 is capped to 1.0 by the element-volume clamp. */
  setMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(2, volume));
    if (clamped === this.#masterVolume) return;
    this.#masterVolume = clamped;
    for (const node of this.#nodes.values()) this.#refreshNode(node);
  }

  /** Replace the entire per-user volume table (e.g. on connect, from persisted settings). */
  setUserVolumes(volumes: Record<string, number>): void {
    this.#userVolumes.clear();
    for (const [uid, v] of Object.entries(volumes)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const clamped = Math.max(0, Math.min(4, v));
      if (clamped !== 1) this.#userVolumes.set(uid, clamped);
    }
    for (const node of this.#nodes.values()) this.#refreshNode(node);
  }

  /** Switch the audible voice output to `deviceId`. On mobile the `<audio>`
   *  anchors honour `setSinkId` directly. On desktop a live `setSinkId` on the
   *  running AudioContext does NOT reliably reroute audio fed by WebRTC
   *  `MediaStreamSource`s — the device stays put until restart — so we recycle
   *  the context instead: the retained, muted anchors keep each track's decoder
   *  alive while the graph is rebuilt on a fresh context bound to the new sink. */
  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.#mobile) {
      await Promise.all([...this.#nodes.values()].map((n) => applySinkId(n.anchor, deviceId)));
      return;
    }
    // No context yet → the next attach() builds one already bound to this sink.
    if (!this.#ctx) return;
    const live = [...this.#nodes.entries()].map(([sid, n]) => ({
      sid,
      userId: n.userId,
      stream: n.anchor.srcObject as MediaStream | null,
      anchor: n.anchor
    }));
    const spatialMode = this.#spatialMode;
    this.#teardownSpatial();
    for (const n of this.#nodes.values()) this.#disconnectGraph(n);
    this.#nodes.clear();
    this.#userSids.clear();
    // Swap in the fresh context *before* closing the old one: a concurrent
    // attach()/detach() must see the new ctx, not the closed one.
    const oldCtx = this.#ctx;
    const ctx = new AudioContext();
    this.#ctx = ctx;
    if (deviceId) await applySinkId(ctx, deviceId);
    for (const e of live) if (e.stream) this.#attachDesktopNode(ctx, e.sid, e.userId, e.stream, e.anchor);
    if (spatialMode !== 'off') void this.setSpatialMode(spatialMode);
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    void oldCtx.close().catch(() => undefined);
  }

  /** Re-trigger playback (resume the AudioContext + replay any anchor audio
   *  elements that autoplay refused) after a user gesture. */
  replayAll(): void {
    const ctx = this.#ctx;
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    for (const node of this.#nodes.values()) {
      void node.anchor.play().catch(() => undefined);
    }
  }

  clear(): void {
    for (const sid of [...this.#nodes.keys()]) this.detach(sid);
  }

  /** Final teardown: clears all nodes then closes and releases the AudioContext. */
  destroy(): void {
    this.clear();
    this.#spatial?.destroy();
    this.#spatial = null;
    this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
  }

  /** Disconnect every node of `node`'s graph (source → compressor → gain →
   *  limiter). Shared by `detach` (full teardown, anchor goes too) and the
   *  output-device rebuild (graph swap that keeps the anchor + decoder alive).
   *  Idempotent. */
  #disconnectGraph(node: AudioNodeBundle): void {
    try { node.source?.disconnect(); } catch { /* already gone */ }
    try { node.compressor?.disconnect(); } catch { /* already gone */ }
    try { node.gain?.disconnect(); } catch { /* already gone */ }
    try { node.limiter?.disconnect(); } catch { /* already gone */ }
  }

  /** Build + register one desktop Web Audio node (source → [compressor] → gain →
   *  [limiter] → spatial|destination) for `stream`, reusing `anchor` as the
   *  muted decoder-keepalive. Shared by attach() and the output-device rebuild
   *  so the wiring lives in exactly one place. */
  #attachDesktopNode(
    ctx: AudioContext,
    sid: string,
    userId: string,
    stream: MediaStream,
    anchor: HTMLAudioElement
  ): void {
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const node: AudioNodeBundle = { source, compressor: null, gain, limiter: null, anchor, userId };
    source.connect(gain);
    this.#spatial?.ensureSource(userId);
    gain.connect(this.#outputTarget(node, ctx));
    this.#syncNode(node);
    this.#nodes.set(sid, node);
    this.#indexUser(userId, sid);
  }

  /** Maintain the secondary userId→sids index for O(1) setUserVolume lookup. */
  #indexUser(userId: string, sid: string): void {
    let sids = this.#userSids.get(userId);
    if (!sids) { sids = new Set(); this.#userSids.set(userId, sids); }
    sids.add(sid);
  }

  /** Effective `<audio>.volume` (0..1) for the mobile path. Per-user × master,
   *  both capped at 100 % since HTMLMediaElement.volume can't exceed 1.0. */
  #elementVolume(userId: string): number {
    const mult = (this.#userVolumes.get(userId) ?? 1) * this.#masterVolume;
    return Math.max(0, Math.min(1, mult));
  }

  /** Create a DynamicsCompressorNode with the given parameter set. Shared by the
   *  >100 % boost compressor and the playback peak limiter — both are
   *  DynamicsCompressorNodes differing only in their parameter values. */
  #makeCompressor(
    ctx: AudioContext,
    cfg: { threshold: number; knee: number; ratio: number; attack: number; release: number }
  ): DynamicsCompressorNode {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = cfg.threshold;
    comp.knee.value = cfg.knee;
    comp.ratio.value = cfg.ratio;
    comp.attack.value = cfg.attack;
    comp.release.value = cfg.release;
    return comp;
  }

  /** Apply the current volume state to one node: mobile sets the element
   *  volume, desktop re-syncs the Web Audio gain (compressor/limiter follow
   *  from #syncNode). Shared by every volume-affecting setter. */
  #refreshNode(node: AudioNodeBundle): void {
    if (this.#mobile) node.anchor.volume = this.#elementVolume(node.userId);
    else this.#syncNode(node);
  }

  #computeGain(userId: string): number {
    if (this.deafened) return 0;
    const userMultiplier = this.#userVolumes.get(userId) ?? 1;
    return userMultiplier * this.#masterVolume * RemoteAudioElements.DEFAULT_MAKEUP_GAIN;
  }

  /** Toggle the playback peak limiter for every current + future track.
   *  No-op on mobile (the limiter is a Web Audio tail node). */
  setLimiterEnabled(on: boolean): void {
    this.#limiterEnabled = on;
    if (this.#mobile) return;
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const node of this.#nodes.values()) this.#applyLimiterTail(node, ctx);
  }

  /** Apply the current effective gain to `node` and splice the compressor in
   *  (when the user-facing volume is >100 %) or out (otherwise). The makeup
   *  factor is intentionally excluded from the compressor trigger — otherwise
   *  every track would be compressed at default volume, which is the bug this
   *  whole branch exists to fix. Idempotent. Desktop-only (no-op without a
   *  Web Audio graph). */
  #syncNode(node: AudioNodeBundle): void {
    const ctx = this.#ctx;
    if (!ctx || !node.gain || !node.source) return;
    node.gain.gain.value = this.#computeGain(node.userId);
    const needsCompressor = (this.#userVolumes.get(node.userId) ?? 1) > 1;
    if (needsCompressor && !node.compressor) {
      try { node.source.disconnect(node.gain); } catch { /* already detached */ }
      const comp = this.#makeCompressor(ctx, RemoteAudioElements.COMPRESSOR);
      node.source.connect(comp);
      comp.connect(node.gain);
      node.compressor = comp;
    } else if (!needsCompressor && node.compressor) {
      try { node.source.disconnect(node.compressor); } catch { /* */ }
      try { node.compressor.disconnect(); } catch { /* */ }
      node.compressor = null;
      node.source.connect(node.gain);
    }
    this.#applyLimiterTail(node, ctx);
  }

  /** Splice the peak limiter into `node`'s tail (gain → limiter → destination)
   *  or remove it (gain → destination), matching `#limiterEnabled`. Idempotent
   *  — only rewires when the actual state differs, so a plain volume change
   *  doesn't glitch the graph. Desktop-only. */
  #applyLimiterTail(node: AudioNodeBundle, ctx: AudioContext): void {
    if (!node.gain) return;
    const dest = this.#outputTarget(node, ctx);
    if (this.#limiterEnabled && !node.limiter) {
      try { node.gain.disconnect(dest); } catch { /* not connected */ }
      const lim = this.#makeCompressor(ctx, RemoteAudioElements.LIMITER);
      node.gain.connect(lim);
      lim.connect(dest);
      node.limiter = lim;
    } else if (!this.#limiterEnabled && node.limiter) {
      try { node.gain.disconnect(node.limiter); } catch { /* */ }
      try { node.limiter.disconnect(); } catch { /* */ }
      node.limiter = null;
      node.gain.connect(dest);
    }
  }

  /** Where a node's chain tail should terminate: the participant's Resonance
   *  source input when spatial audio is active, else `ctx.destination`. */
  #outputTarget(node: AudioNodeBundle, ctx: AudioContext): AudioNode {
    return this.#spatial?.sourceInput(node.userId) ?? ctx.destination;
  }

  /** Reconnect a node's current tail (limiter if present, else gain) to the
   *  output target — used after the spatial mode changes without the limiter
   *  state changing. `gain → comp/source` wiring is untouched. */
  #rewireOutput(node: AudioNodeBundle, ctx: AudioContext): void {
    const tail = node.limiter ?? node.gain;
    if (!tail) return;
    try { tail.disconnect(); } catch { /* already gone */ }
    tail.connect(this.#outputTarget(node, ctx));
  }

  /** Set the spatial-audio mode. Builds/destroys the binaural scene (lazily
   *  fetching the vendored engine on first use) and reroutes every track.
   *  No-op on mobile (no Web Audio graph to spatialise). */
  async setSpatialMode(mode: SpatialMode): Promise<void> {
    this.#spatialMode = mode;
    if (this.#mobile) return;
    const token = ++this.#spatialBuildToken;

    if (mode === 'off') {
      this.#teardownSpatial();
      return;
    }
    const ctx = this.#ctx;
    if (!ctx) return; // no active playback yet — applied when tracks attach

    try {
      const Ctor = await loadResonance();
      if (token !== this.#spatialBuildToken) return; // superseded by a newer call
      this.#spatial?.destroy();
      this.#spatial = new SpatialScene(Ctor, ctx, resolveQuality(mode), this.#spatialLayout);
      for (const node of this.#nodes.values()) {
        this.#spatial.ensureSource(node.userId);
        this.#rewireOutput(node, ctx);
      }
    } catch {
      this.#teardownSpatial(); // load failed → stay on the flat mix
    }
  }

  /** Set the frontal-fan layout (total arc + shared distance) for all speakers. */
  setSpatialLayout(spreadDeg: number, distanceM: number): void {
    this.#spatialLayout = { spreadDeg, distanceM };
    this.#spatial?.setLayout(spreadDeg, distanceM);
  }

  #teardownSpatial(): void {
    if (!this.#spatial) return;
    this.#spatial.destroy();
    this.#spatial = null;
    const ctx = this.#ctx;
    if (ctx) for (const node of this.#nodes.values()) this.#rewireOutput(node, ctx);
  }
}
