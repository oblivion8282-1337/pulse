/**
 * Sound playback engine. HTMLAudioElement-pooled to allow rapid retriggers
 * without re-loading the asset. Tolerant of missing files — a 404 marks the
 * URL as "missing" and silences further plays for it (no console-spam, no
 * exception). Autoplay policy: the very first play before user-gesture may
 * be blocked by Chromium; we catch and swallow.
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
      p.catch(() => {
        /* autoplay-block or other transient errors — silent */
      });
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
      // MEDIA_ERR_NETWORK (2) typically maps to 404, MEDIA_ERR_SRC_NOT_SUPPORTED
      // (4) covers wrong codec / decoder failure. Both mean "stop trying".
      const code = a.error?.code;
      if (code === 2 || code === 4) {
        this.#missing.add(url);
      }
    });
    pool.push(a);
    return a;
  }
}

export const sounds = new SoundEngine();
