/**
 * Sound playback engine. HTMLAudioElement-pooled to allow rapid retriggers
 * without re-loading the asset. Tolerant of missing files — a genuinely
 * unplayable asset (decoder failure / 404 → MEDIA_ERR_SRC_NOT_SUPPORTED)
 * marks the URL as "missing" and silences further plays for it (no
 * console-spam, no exception). Transient errors (network abort, a play
 * interrupted by a quick leave) do NOT blacklist — they only discard the one
 * bad pooled element so the next play rebuilds a fresh one. Autoplay policy:
 * the very first play before user-gesture may be blocked by Chromium; we
 * catch and swallow.
 *
 * Volume = settings.sounds.masterVolume * category.volume (gated by
 * masterEnabled + category.enabled). `test(id)` bypasses the toggle gating
 * so users can audition a sound even if its category is disabled.
 *
 * Per-guild overrides: callers pass ``{ guildId }`` when the trigger has a
 * guild context (voice, notifications, message-send). The resolver checks
 * ``guildSounds.urlFor`` first, falls back to the bundled ``/sounds/<file>.ogg``
 * otherwise. Pools + missing-set are keyed by URL so guilds with custom
 * sounds don't fight over a SoundId slot.
 */

import { settings } from '$lib/stores/settings.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { SOUNDS, type SoundId, type SoundCategory } from './registry';

const SOUND_DIR = '/sounds';
const SOUND_EXT = 'ogg';
const DEBOUNCE_MS = 50;
const MAX_CONCURRENT_PER_URL = 3;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function categoryGain(category: SoundCategory): number {
  const s = settings.sounds;
  if (!s.masterEnabled) return 0;
  const cat = s[category];
  if (!cat.enabled) return 0;
  return clamp01(s.masterVolume) * clamp01(cat.volume);
}

function bypassGain(category: SoundCategory): number {
  const s = settings.sounds;
  return clamp01(s.masterVolume) * clamp01(s[category].volume);
}

function defaultUrl(id: SoundId): string {
  return `${SOUND_DIR}/${SOUNDS[id].file}.${SOUND_EXT}`;
}

export type PlayOpts = {
  /** Guild whose overrides should be consulted. Omit for guild-less
   * events (DM notifications, generic UI). */
  guildId?: string | null;
};

class SoundEngine {
  #pool = new Map<string, HTMLAudioElement[]>();
  #lastPlay = new Map<string, number>();
  #missing = new Set<string>();

  /** Play if the relevant category-toggle is on. Silent no-op otherwise. */
  play(id: SoundId, opts: PlayOpts = {}): void {
    if (typeof Audio === 'undefined') return;
    const def = SOUNDS[id];
    const gain = categoryGain(def.category);
    if (gain <= 0) return;
    const url = this.#resolve(id, opts.guildId);
    if (this.#missing.has(url)) return;
    this.#emit(url, gain);
  }

  /** Force-play for settings UI test buttons — respects master + category
   *  volume but ignores per-category `enabled` so users can audition. */
  test(id: SoundId, opts: PlayOpts = {}): void {
    if (typeof Audio === 'undefined') return;
    const def = SOUNDS[id];
    const gain = bypassGain(def.category);
    if (gain <= 0) return;
    const url = this.#resolve(id, opts.guildId);
    if (this.#missing.has(url)) return;
    this.#emit(url, gain);
  }

  /** Returns true if the *default* asset for ``id`` is missing. The
   *  per-user Settings → Sounds panel uses this to grey-out the test
   *  button when the bundled file is absent. Per-guild overrides have
   *  their own missing-state which the engine handles silently. */
  isMissing(id: SoundId): boolean {
    return this.#missing.has(defaultUrl(id));
  }

  /** Drop a single URL from the pool + missing-set. Called when the
   * backend tells us a guild's override changed — the cached
   * HTMLAudioElement still points at the old (expired) presigned URL
   * and a re-play would silently fail. */
  invalidateUrl(url: string): void {
    this.#pool.delete(url);
    this.#missing.delete(url);
    this.#lastPlay.delete(url);
  }

  #resolve(id: SoundId, guildId: string | null | undefined): string {
    const override = guildSounds.urlFor(id, guildId);
    return override ?? defaultUrl(id);
  }

  #emit(url: string, gain: number): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this.#lastPlay.get(url) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.#lastPlay.set(url, now);
    this.#start(url, gain, true);
  }

  /**
   * Acquire a pooled element and play it. A pooled element can be left in a
   * state where `play()` rejects: a prior play was *interrupted* (you left the
   * channel while the join chime was still loading/playing → AbortError), the
   * element was paused mid-load, or a transient seek/decode race hit. When that
   * happens we discard the bad element and retry ONCE with a freshly-built one
   * — without that retry the same broken element keeps getting reused and the
   * sound silently goes missing on a re-join. We do NOT retry NotAllowedError
   * (autoplay block): a fresh element won't help until the next user gesture.
   */
  #start(url: string, gain: number, allowRetry: boolean): void {
    const audio = this.#acquire(url);
    if (!audio) return;
    audio.volume = clamp01(gain);
    try {
      audio.currentTime = 0;
    } catch {
      /* some browsers throw if metadata hasn't loaded — ignore */
    }
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : '';
        if (allowRetry && name !== 'NotAllowedError') {
          this.#discard(url, audio);
          this.#start(url, gain, false);
        }
        /* NotAllowedError (autoplay) or second failure — silent */
      });
    }
  }

  /** Drop a single element from its pool so the next acquire rebuilds a fresh
   *  one. Pauses it first to release the decoder. */
  #discard(url: string, audio: HTMLAudioElement): void {
    const pool = this.#pool.get(url);
    if (pool) {
      const i = pool.indexOf(audio);
      if (i >= 0) pool.splice(i, 1);
    }
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
  }

  #acquire(url: string): HTMLAudioElement | null {
    let pool = this.#pool.get(url);
    if (!pool) {
      pool = [];
      this.#pool.set(url, pool);
    }
    for (const a of pool) {
      if (a.paused || a.ended) return a;
    }
    if (pool.length >= MAX_CONCURRENT_PER_URL) {
      const a = pool[0];
      try {
        a.pause();
      } catch {
        /* ignore */
      }
      return a;
    }
    const a = new Audio(url);
    a.preload = 'auto';
    a.addEventListener('error', () => {
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4) = wrong codec / decoder failure / 404 →
      // genuinely unplayable, blacklist the URL so we stop trying. MEDIA_ERR_*
      // ABORTED (1) / NETWORK (2) are typically transient (a load interrupted
      // by a quick leave, dev-server latency) — don't blacklist, just drop this
      // element so the next play rebuilds a fresh one.
      if (a.error?.code === 4) {
        this.#missing.add(url);
      } else {
        this.#discard(url, a);
      }
    });
    pool.push(a);
    return a;
  }
}

export const sounds = new SoundEngine();
