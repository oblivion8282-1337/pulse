import type { RemoteAudioTrack } from 'livekit-client';

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

interface AudioNodeBundle {
  source: MediaStreamAudioSourceNode;
  /** Null while effective gain ≤ 1.0 — at default volume the path is a
   *  straight `source → gain → destination`. Spliced in lazily once the user
   *  boosts above 100 %, removed again when they reset. */
  compressor: DynamicsCompressorNode | null;
  gain: GainNode;
  /** Muted <audio> sink that keeps Chromium's WebRTC decoder running. Without
   *  it, MediaStreamAudioSourceNode produces no output for RTCPeerConnection
   *  tracks — known Chromium bug. We never hear this element (muted=true);
   *  the audible path is source → [compressor →] gain → ctx.destination. */
  anchor: HTMLAudioElement;
  userId: string;
}

/**
 * Owns the Web Audio routing for remote participant mic tracks (not
 * screen-share — those live in ScreenShareTile). Default path is a 1:1
 * pass-through `source → gain → destination`; a DynamicsCompressorNode is
 * spliced in only while a user is boosted >100 %, to catch the clipping
 * linear gain would otherwise produce on loud speakers.
 *
 * Why not the previous `<audio>` approach: `HTMLMediaElement.volume` is
 * spec-clamped to 0..1, so a per-user "louder than 100 %" slider had no way
 * to work. A Web Audio graph has no such ceiling.
 */
export class RemoteAudioElements {
  #ctx: AudioContext | null = null;
  #nodes = new Map<string, AudioNodeBundle>();
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
  deafened = false;
  outputDeviceId = '';

  #ensureContext(): AudioContext {
    if (this.#ctx) return this.#ctx;
    const ctx = new AudioContext();
    if (this.outputDeviceId) void this.#applySink(ctx, this.outputDeviceId);
    this.#ctx = ctx;
    return ctx;
  }

  /** Called when a remote audio track is subscribed. `onBlocked` fires if the
   *  AudioContext is suspended (autoplay policy) — same trigger semantics as
   *  the old HTMLAudioElement-based flow. */
  attach(track: RemoteAudioTrack, userId: string, onBlocked: () => void): void {
    const sid = track.sid ?? `t-${Math.random()}`;
    if (this.#nodes.has(sid)) return;
    const mst = track.mediaStreamTrack;
    if (!mst) return;
    const ctx = this.#ensureContext();
    const stream = new MediaStream([mst]);

    const anchor = document.createElement('audio');
    anchor.autoplay = true;
    anchor.muted = true;
    anchor.srcObject = stream;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    void anchor.play().catch(() => undefined);

    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const node: AudioNodeBundle = { source, compressor: null, gain, anchor, userId };
    source.connect(gain);
    this.#syncNode(node);
    this.#nodes.set(sid, node);

    if (ctx.state === 'suspended') void ctx.resume().catch(onBlocked);
  }

  detach(sid: string): void {
    const node = this.#nodes.get(sid);
    if (!node) return;
    try { node.source.disconnect(); } catch { /* already gone */ }
    try { node.compressor?.disconnect(); } catch { /* already gone */ }
    try { node.gain.disconnect(); } catch { /* already gone */ }
    node.anchor.srcObject = null;
    node.anchor.remove();
    this.#nodes.delete(sid);
  }

  setDeafened(on: boolean): void {
    this.deafened = on;
    for (const node of this.#nodes.values()) this.#syncNode(node);
  }

  setUserVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(4, volume));
    if (clamped === 1) this.#userVolumes.delete(userId);
    else this.#userVolumes.set(userId, clamped);
    for (const node of this.#nodes.values()) {
      if (node.userId === userId) this.#syncNode(node);
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
    for (const node of this.#nodes.values()) this.#syncNode(node);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
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

  #computeGain(userId: string): number {
    if (this.deafened) return 0;
    return this.#userVolumes.get(userId) ?? 1;
  }

  /** Apply the current effective gain to `node` and splice the compressor in
   *  (when boosted >100 %) or out (otherwise). Idempotent. */
  #syncNode(node: AudioNodeBundle): void {
    const g = this.#computeGain(node.userId);
    node.gain.gain.value = g;
    const needsCompressor = g > 1;
    if (needsCompressor && !node.compressor) {
      try { node.source.disconnect(node.gain); } catch { /* already detached */ }
      const ctx = this.#ctx;
      if (!ctx) return;
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
}
