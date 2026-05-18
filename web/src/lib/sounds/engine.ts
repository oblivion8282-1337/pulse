/**
 * Sound playback engine. HTMLAudioElement-pooled to allow rapid retriggers
 * without re-loading the asset. Tolerant of missing files — a 404 marks the
 * sound as "missing" and silences all further `play(id)` calls for it
 * (no console-spam, no exception). Autoplay policy: the very first play
 * before user-gesture may be blocked by Chromium; we catch and swallow.
 *
 * Volume = settings.sounds.masterVolume * category.volume (gated by
 * masterEnabled + category.enabled). `test(id)` bypasses the toggle gating
 * so users can audition a sound even if its category is disabled.
 */

import { settings } from '$lib/stores/settings.svelte';
import { SOUNDS, type SoundId, type SoundCategory } from './registry';

const SOUND_DIR = '/sounds';
const SOUND_EXT = 'ogg';
const DEBOUNCE_MS = 50;
const MAX_CONCURRENT_PER_ID = 3;

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

class SoundEngine {
  #pool = new Map<SoundId, HTMLAudioElement[]>();
  #lastPlay = new Map<SoundId, number>();
  #missing = new Set<SoundId>();

  /** Play if the relevant category-toggle is on. Silent no-op otherwise. */
  play(id: SoundId): void {
    if (typeof Audio === 'undefined') return;
    if (this.#missing.has(id)) return;
    const def = SOUNDS[id];
    const gain = categoryGain(def.category);
    if (gain <= 0) return;
    this.#emit(id, gain);
  }

  /** Force-play for settings UI test buttons — respects master + category
   *  volume but ignores per-category `enabled` so users can audition. */
  test(id: SoundId): void {
    if (typeof Audio === 'undefined') return;
    if (this.#missing.has(id)) return;
    const def = SOUNDS[id];
    const gain = bypassGain(def.category);
    if (gain <= 0) return;
    this.#emit(id, gain);
  }

  /** Returns true if a 404/decode-error has marked this sound unavailable.
   *  Settings UI uses it to disable the Test-Button and show a hint. */
  isMissing(id: SoundId): boolean {
    return this.#missing.has(id);
  }

  #emit(id: SoundId, gain: number): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this.#lastPlay.get(id) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.#lastPlay.set(id, now);

    const audio = this.#acquire(id);
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

  #acquire(id: SoundId): HTMLAudioElement | null {
    let pool = this.#pool.get(id);
    if (!pool) {
      pool = [];
      this.#pool.set(id, pool);
    }
    for (const a of pool) {
      if (a.paused || a.ended) return a;
    }
    if (pool.length >= MAX_CONCURRENT_PER_ID) {
      const a = pool[0];
      try {
        a.pause();
      } catch {
        /* ignore */
      }
      return a;
    }
    const def = SOUNDS[id];
    const a = new Audio(`${SOUND_DIR}/${def.file}.${SOUND_EXT}`);
    a.preload = 'auto';
    a.addEventListener('error', () => {
      // MEDIA_ERR_NETWORK (2) typically maps to 404, MEDIA_ERR_SRC_NOT_SUPPORTED
      // (4) covers wrong codec / decoder failure. Both mean "stop trying".
      const code = a.error?.code;
      if (code === 2 || code === 4) {
        this.#missing.add(id);
      }
    });
    pool.push(a);
    return a;
  }
}

export const sounds = new SoundEngine();
