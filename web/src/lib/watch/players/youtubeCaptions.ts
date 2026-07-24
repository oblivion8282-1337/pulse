/**
 * Caption (subtitle) control for the YouTube IFrame player.
 *
 * Why this exists: a watch-party VIEWER gets `controls: 0`, so the native CC
 * button is gone. If that viewer's YouTube/browser preference turns subtitles
 * on, they are stuck with them. This gives the tile a way to hand the control
 * back — see WatchCaptionsMenu.
 *
 * How YouTube exposes captions — and the caveats, because they shape every
 * decision below:
 *
 *  - The player loads "modules" that add API surface; `getOptions()` lists the
 *    loaded ones and `onApiChange` fires when that set changes. Captions live
 *    in the `captions` module (the old `cc` module belonged to the retired
 *    Flash player and is gone).
 *  - Google officially documents only `fontSize` and `reload` for that module.
 *    `track` / `tracklist` are long-standing but UNOFFICIAL. They work today
 *    and are the only way to toggle captions at all — but they may vanish
 *    without notice, so every call is wrapped: on any failure we report "no
 *    tracks" and the tile hides its CC control instead of throwing.
 *  - `onApiChange` only fires once playback has STARTED. So the control cannot
 *    appear at mount; it shows up a moment into the video. Fine for us — a
 *    viewer autoplays into a running party.
 *  - Consequently, if YouTube never loads the module (a video with no captions
 *    at all), the control simply never appears. That is the correct outcome.
 *
 * Two behaviours measured against the real player (both cost a bug once, both
 * are the reason this file looks the way it does):
 *
 *  1. AUTO-GENERATED captions do NOT show up in `tracklist` — it comes back as
 *     an EMPTY array while `track` reports an active language. So "no tracks"
 *     must never be read as "no captions": that is exactly the case where a
 *     viewer sits in front of subtitles they cannot switch off. The caller
 *     therefore also asks {@link CaptionsControl.getActiveCaptionTrack}, and
 *     {@link CaptionsControl.isAvailable} tells it whether any of this is
 *     meaningful yet.
 *  2. `getOption('captions','track')` is only trustworthy BEFORE we write. Once
 *     we've called setOption it keeps reporting the old language even though
 *     the captions are visibly gone. Read it once, then own the state (see
 *     CaptionsState) — never poll it back to drive the UI.
 */

// The YT player object — same deliberately-loose typing as YouTubePlayer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YTPlayer = any;

import type { CaptionTrack } from '../sync';

export interface CaptionsControl {
  /** True once the player's captions module is loaded — i.e. once the other
   * three methods say anything meaningful. Before that, "no tracks" and "off"
   * are merely "don't know yet". */
  isAvailable(): boolean;
  getCaptionTracks(): CaptionTrack[];
  getActiveCaptionTrack(): string | null;
  setCaptionTrack(languageCode: string | null): void;
}

/** True once the player has loaded the captions module. Everything else is a
 * no-op before that — calling setOption on an unloaded module does nothing. */
function captionsLoaded(player: YTPlayer | undefined): boolean {
  if (!player) return false;
  try {
    const modules = player.getOptions?.();
    return Array.isArray(modules) && modules.includes('captions');
  } catch {
    return false;
  }
}

/** Pick the most human-readable name YouTube offers for a track. The tracklist
 * entries carry different name fields depending on the track kind (manual vs.
 * auto-generated), so fall back through them and finally to the raw code. */
function trackLabel(raw: Record<string, unknown>, code: string): string {
  for (const key of ['displayName', 'languageName', 'name']) {
    const value = raw[key];
    if (typeof value === 'string' && value) return value;
    // Some entries nest the name as { simpleText: '…' }.
    if (value && typeof value === 'object') {
      const simple = (value as Record<string, unknown>).simpleText;
      if (typeof simple === 'string' && simple) return simple;
    }
  }
  return code;
}

export function createCaptionsControl(getPlayer: () => YTPlayer | undefined): CaptionsControl {
  return {
    isAvailable(): boolean {
      return captionsLoaded(getPlayer());
    },

    getCaptionTracks(): CaptionTrack[] {
      const player = getPlayer();
      if (!captionsLoaded(player)) return [];
      try {
        const list = player.getOption('captions', 'tracklist');
        if (!Array.isArray(list)) return [];
        return list
          .map((raw: Record<string, unknown>) => {
            const code = String(raw?.languageCode ?? '');
            return { languageCode: code, label: trackLabel(raw ?? {}, code) };
          })
          .filter((t: CaptionTrack) => !!t.languageCode);
      } catch {
        return [];
      }
    },

    getActiveCaptionTrack(): string | null {
      const player = getPlayer();
      if (!captionsLoaded(player)) return null;
      try {
        // An empty object (or a missing code) is YouTube's "captions off".
        const code = player.getOption('captions', 'track')?.languageCode;
        return code ? String(code) : null;
      } catch {
        return null;
      }
    },

    setCaptionTrack(languageCode: string | null): void {
      const player = getPlayer();
      if (!captionsLoaded(player)) return;
      try {
        player.setOption('captions', 'track', languageCode ? { languageCode } : {});
      } catch {
        // Module went away mid-flight; the next getCaptionTracks() reports
        // empty and the tile drops its control.
      }
    }
  };
}
