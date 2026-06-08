import type { RemoteAudioTrack } from 'livekit-client';
import { isMobile } from '$lib/platform/runtime';

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

interface AudioNodeBundle {
  /** Null on the mobile path — there the `<audio>` element is the audible
   *  source and no Web Audio graph is built. */
  source: MediaStreamAudioSourceNode | null;
  /** Null while effective gain ≤ 1.0 — at default volume the path is a
   *  straight `source → gain → destination`. Spliced in lazily once the user
   *  boosts above 100 %, removed again when they reset. Always null on mobile. */
  compressor: DynamicsCompressorNode | null;
  /** Null on the mobile path (see `source`). */
  gain: GainNode | null;
  /** Null while the playback limiter is off. When on, sits at the tail of the
   *  chain (gain → limiter → destination) so it catches the final post-makeup
   *  level — a participant who suddenly shouts can't blow past your ears.
   *  Always null on mobile. */
  limiter: DynamicsCompressorNode | null;
  /** Desktop: muted <audio> sink that keeps Chromium's WebRTC decoder running.
   *  Without it, MediaStreamAudioSourceNode produces no output for
   *  RTCPeerConnection tracks — known Chromium bug. We never hear this element
   *  (muted=true); the audible path is source → [compressor →] gain → [limiter →]
   *  ctx.destination.
   *  Mobile: this element IS the audible path (unmuted) — see the class doc. */
  anchor: HTMLAudioElement;
  userId: string;
}

/**
 * Owns the playback routing for remote participant mic tracks (not
 * screen-share — those live in ScreenShareTile).
 *
 * **Desktop path (Web Audio graph).** Default path is a 1:1 pass-through
 * `source → gain → destination`; a DynamicsCompressorNode is spliced in only
 * while a user is boosted >100 %, to catch the clipping linear gain would
 * otherwise produce on loud speakers. A second, optional DynamicsCompressorNode
 * (brick-wall limiter) can be spliced into the tail via `setLimiterEnabled` to
 * clamp participants who suddenly get very loud.
 *
 * Why not the previous `<audio>` approach on desktop: `HTMLMediaElement.volume`
 * is spec-clamped to 0..1, so a per-user "louder than 100 %" slider had no way
 * to work. A Web Audio graph has no such ceiling.
 *
 * **Mobile path (`<audio>` element).** Android Chrome / iOS Safari / the TWA
 * suspend a *backgrounded* AudioContext within a few seconds of a screen lock,
 * cutting call audio. An unmuted media element, by contrast, is kept alive by
 * the OS as background media (paired with a MediaSession — see
 * `voice/mediaSession.ts`). So on mobile we skip the Web Audio graph entirely
 * and play each remote track straight through its `<audio>` element. Trade-off:
 * `HTMLMediaElement.volume` is clamped to 0..1, so the per-user >100 % boost is
 * capped at 100 % on mobile. No makeup gain is applied either — the element
 * plays the track at its natural level (the +12 dB makeup only compensated the
 * Chromium level loss through MediaStreamAudioSourceNode, which isn't in play
 * here).
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

  #ensureContext(): AudioContext {
    if (this.#ctx && this.#ctx.state !== 'closed') return this.#ctx;
    if (this.#ctx?.state === 'closed') this.#ctx = null;
    const ctx = new AudioContext();
    if (this.outputDeviceId) void this.#applySink(ctx, this.outputDeviceId);
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
      if (this.outputDeviceId) void this.#applyElementSink(anchor, this.outputDeviceId);
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
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const node: AudioNodeBundle = { source, compressor: null, gain, limiter: null, anchor, userId };
    source.connect(gain);
    this.#syncNode(node);
    this.#nodes.set(sid, node);
    this.#indexUser(userId, sid);

    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => { if (ctx.state !== 'running') onBlocked(); }).catch(() => onBlocked());
    }
  }

  detach(sid: string): void {
    const node = this.#nodes.get(sid);
    if (!node) return;
    try { node.source?.disconnect(); } catch { /* already gone */ }
    try { node.compressor?.disconnect(); } catch { /* already gone */ }
    try { node.gain?.disconnect(); } catch { /* already gone */ }
    try { node.limiter?.disconnect(); } catch { /* already gone */ }
    node.anchor.srcObject = null;
    node.anchor.remove();
    this.#nodes.delete(sid);
    // Remove from secondary index.
    const sids = this.#userSids.get(node.userId);
    if (sids) {
      sids.delete(sid);
      if (sids.size === 0) this.#userSids.delete(node.userId);
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
        if (!node) continue;
        if (this.#mobile) node.anchor.volume = this.#elementVolume(userId);
        else this.#syncNode(node);
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
    for (const node of this.#nodes.values()) {
      if (this.#mobile) node.anchor.volume = this.#elementVolume(node.userId);
      else this.#syncNode(node);
    }
  }

  /** Replace the entire per-user volume table (e.g. on connect, from persisted settings). */
  setUserVolumes(volumes: Record<string, number>): void {
    this.#userVolumes.clear();
    for (const [uid, v] of Object.entries(volumes)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const clamped = Math.max(0, Math.min(4, v));
      if (clamped !== 1) this.#userVolumes.set(uid, clamped);
    }
    for (const node of this.#nodes.values()) {
      if (this.#mobile) node.anchor.volume = this.#elementVolume(node.userId);
      else this.#syncNode(node);
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.#mobile) {
      await Promise.all(
        [...this.#nodes.values()].map((n) => this.#applyElementSink(n.anchor, deviceId))
      );
      return;
    }
    if (this.#ctx) await this.#applySink(this.#ctx, deviceId);
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
      const comp = ctx.createDynamicsCompressor();
      const c = RemoteAudioElements.COMPRESSOR;
      comp.threshold.value = c.threshold;
      comp.knee.value = c.knee;
      comp.ratio.value = c.ratio;
      comp.attack.value = c.attack;
      comp.release.value = c.release;
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
    if (this.#limiterEnabled && !node.limiter) {
      try { node.gain.disconnect(ctx.destination); } catch { /* not connected */ }
      const lim = ctx.createDynamicsCompressor();
      const l = RemoteAudioElements.LIMITER;
      lim.threshold.value = l.threshold;
      lim.knee.value = l.knee;
      lim.ratio.value = l.ratio;
      lim.attack.value = l.attack;
      lim.release.value = l.release;
      node.gain.connect(lim);
      lim.connect(ctx.destination);
      node.limiter = lim;
    } else if (!this.#limiterEnabled && node.limiter) {
      try { node.gain.disconnect(node.limiter); } catch { /* */ }
      try { node.limiter.disconnect(); } catch { /* */ }
      node.limiter = null;
      node.gain.connect(ctx.destination);
    }
  }

  async #applySink(target: AudioContext, deviceId: string): Promise<void> {
    if (!deviceId) return;
    const cap = target as unknown as SinkCapable;
    if (typeof cap.setSinkId !== 'function') return;
    try {
      await cap.setSinkId(deviceId);
    } catch {
      /* Chrome ≥110 / Electron supports this; Firefox/Safari don't yet. */
    }
  }

  async #applyElementSink(el: HTMLAudioElement, deviceId: string): Promise<void> {
    if (!deviceId) return;
    const cap = el as unknown as SinkCapable;
    if (typeof cap.setSinkId !== 'function') return;
    try {
      await cap.setSinkId(deviceId);
    } catch {
      /* setSinkId on media elements: not supported everywhere (esp. iOS). */
    }
  }
}
