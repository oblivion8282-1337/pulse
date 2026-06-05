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
/** Browsers decode .ogg/.mp3 transparently — we try each in order at
 *  first play and cache whichever loads. Order matters: prefer OGG
 *  Vorbis (smaller, matches the existing 13 bundled assets) and fall
 *  back to .mp3 if the .ogg slot is empty. Per-guild user uploads
 *  bypass this chain — the override URL is whatever the browser
 *  fetched, and the per-guild MinIO upload pins content-type. */
const SOUND_EXTS = ['ogg', 'mp3'] as const;
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

function defaultUrls(id: SoundId): string[] {
  return SOUND_EXTS.map((ext) => `${SOUND_DIR}/${SOUNDS[id].file}.${ext}`);
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
    if (url === null) return;
    this.#emit(id, url, gain);
  }

  /** Force-play for settings UI test buttons — respects master + category
   *  volume but ignores per-category `enabled` so users can audition. */
  test(id: SoundId, opts: PlayOpts = {}): void {
    if (typeof Audio === 'undefined') return;
    const def = SOUNDS[id];
    const gain = bypassGain(def.category);
    if (gain <= 0) return;
    const url = this.#resolve(id, opts.guildId);
    if (url === null) return;
    this.#emit(id, url, gain);
  }

  /** Returns true if the *default* asset for ``id`` is missing. The
   *  per-user Settings → Sounds panel uses this to grey-out the test
   *  button when the bundled file is absent. We treat a sound as
   *  missing only when *every* candidate extension in the chain has
   *  failed to load — that way the test button stays interactive as
   *  long as the user could still drop a .mp3 in to fill the gap. */
  isMissing(id: SoundId): boolean {
    return defaultUrls(id).every((url) => this.#missing.has(url));
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

  #resolve(id: SoundId, guildId: string | null | undefined): string | null {
    const override = guildSounds.urlFor(id, guildId);
    if (override) return override;
    for (const url of defaultUrls(id)) {
      if (!this.#missing.has(url)) return url;
    }
    return null;
  }

  /** Pick the next URL in the default-extension chain after ``current``.
   *  Returns null if ``current`` is the last candidate, or if it's not
   *  part of the chain (e.g. a per-guild override URL — those are
   *  single-shot, no fallback). */
  #nextDefaultUrl(id: SoundId, current: string): string | null {
    const urls = defaultUrls(id);
    const idx = urls.indexOf(current);
    if (idx < 0 || idx >= urls.length - 1) return null;
    return urls[idx + 1];
  }

  #emit(id: SoundId, url: string, gain: number): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = this.#lastPlay.get(url) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.#lastPlay.set(url, now);
    this.#start(id, url, gain, true);
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
   *
   * For *default* URLs the source-load failure (404 / unsupported
   * format) is caught via the `error` event and triggers a chain
   * fallback to the next extension in the chain (e.g. .ogg missing →
   * try .mp3). Override URLs skip the chain since the user uploaded
   * whatever the browser fetched.
   */
  #start(id: SoundId, url: string, gain: number, allowRetry: boolean): void {
    const audio = this.#acquire(url);
    if (!audio) return;
    audio.volume = clamp01(gain);
    try {
      audio.currentTime = 0;
    } catch {
      /* some browsers throw if metadata hasn't loaded — ignore */
    }
    let handled = false;
    const onLoadFail = () => {
      if (handled) return;
      handled = true;
      this.#discard(url, audio);
      this.#missing.add(url);
      const next = this.#nextDefaultUrl(id, url);
      if (next) this.#start(id, next, gain, false);
    };
    const onPlayFail = () => {
      if (handled) return;
      handled = true;
      if (!allowRetry) return;
      this.#discard(url, audio);
      this.#start(id, url, gain, false);
    };
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError') return;
        // Same guard as the error-event listener below — a transient
        // decode/seek glitch on an element that HAD buffered playable
        // data (the "PTS is not defined" Chromium FFmpeg demuxer quirk
        // called out in `#acquire`) must NOT trigger the chain fallback,
        // it just needs a fresh element for the same URL.
        if (audio.error?.code === 4 && audio.readyState < 2) onLoadFail();
        else onPlayFail();
      });
    }
    audio.addEventListener(
      'error',
      () => {
        if (audio.error?.code === 4 && audio.readyState < 2) onLoadFail();
      },
      { once: true }
    );
  }

  /** Drop a single element from its pool so the next acquire rebuilds a fresh
   *  one. Pauses it first to release the decoder. If the pool is now
   *  empty, remove the URL entry from the pool map — otherwise a chain
   *  of failed `.ogg` then `.mp3` would leave an ever-growing set of
   *  empty per-URL arrays behind. */
  #discard(url: string, audio: HTMLAudioElement): void {
    const pool = this.#pool.get(url);
    if (pool) {
      const i = pool.indexOf(audio);
      if (i >= 0) pool.splice(i, 1);
      if (pool.length === 0) this.#pool.delete(url);
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
    a.addEventListener(
      'error',
      () => {
        // Only a *genuine* load failure — the resource never produced any
        // decodable data (404, wrong container/codec) — should blacklist the URL
        // so we stop retrying. Detect that by readyState < HAVE_CURRENT_DATA: the
        // element never reached playable data.
        //
        // An element that HAD buffered playable data and then errors is NOT
        // missing — it's a transient decode/seek glitch. Some Ogg/Vorbis files
        // make Chromium's FFmpeg demuxer throw MEDIA_ERR_SRC_NOT_SUPPORTED (4)
        // with "DEMUXER_ERROR_COULD_NOT_PARSE: PTS is not defined" when a *pooled*
        // element is re-seeked (`currentTime = 0`) for replay — even though the
        // file plays fine on a fresh element. Blacklisting on that permanently
        // silences a working sound for the whole session (join chime vanishes
        // after the first leave+rejoin). So we only discard the poisoned element;
        // the next play rebuilds a fresh one, which re-decodes cleanly.
        const neverLoaded = a.readyState < 2; // < HAVE_CURRENT_DATA
        if (a.error?.code === 4 && neverLoaded) {
          this.#missing.add(url);
        } else {
          this.#discard(url, a);
        }
      },
      { once: true }
    );
    pool.push(a);
    return a;
  }
}

export const sounds = new SoundEngine();
