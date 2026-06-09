/**
 * oEmbed providers for inline message link previews (Stufe 1 — client-side).
 *
 * Each provider matches a pasted URL and exposes its JSON oEmbed endpoint. Only
 * providers whose oEmbed endpoint sends permissive CORS headers can be fetched
 * straight from the browser — verified 2026-06-09 for YouTube (echoes Origin),
 * Vimeo + Spotify (`*`). Anything that needs server-side scraping (arbitrary
 * Open Graph pages, X/Twitter — its oEmbed 301s into the rate-limited API and
 * is unreliable client-side) is intentionally out of scope here and belongs to
 * the future server-side unfurl path.
 *
 * The card itself ({@link '$lib/components/LinkEmbed.svelte'}) only renders
 * escaped text + an https-validated thumbnail, so a hostile oEmbed response
 * can't inject markup.
 */

export interface EmbedProvider {
  /** Stable id, also the display fallback when oEmbed omits provider_name. */
  name: string;
  /** True if this provider handles the given (already-parsed) URL. */
  matches(u: URL): boolean;
  /** Build the JSON oEmbed endpoint for the raw URL. */
  oembedUrl(raw: string): string;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'www.youtube-nocookie.com'
]);
// Only real video paths — channel/feed/results pages must not trigger a fetch.
// `/watch` is handled separately (it needs a `?v=`, else it's a playlist page).
const YOUTUBE_VIDEO_PATH = /^\/(embed\/|shorts\/|live\/)/;

const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const VIMEO_VIDEO_PATH = /^\/(video\/)?\d+(?:\/|$)/;

const SPOTIFY_PATH = /\/(track|album|playlist|episode|show|artist)\/[A-Za-z0-9]+/;

export const PROVIDERS: EmbedProvider[] = [
  {
    name: 'YouTube',
    matches: (u) => {
      const host = u.hostname.toLowerCase();
      if (host === 'youtu.be') return /^\/[A-Za-z0-9_-]{6,}/.test(u.pathname);
      return (
        YOUTUBE_HOSTS.has(host) &&
        (YOUTUBE_VIDEO_PATH.test(u.pathname) ||
          (u.pathname === '/watch' && u.searchParams.has('v')))
      );
    },
    oembedUrl: (raw) =>
      `https://www.youtube.com/oembed?url=${encodeURIComponent(raw)}&format=json`
  },
  {
    name: 'Vimeo',
    matches: (u) =>
      VIMEO_HOSTS.has(u.hostname.toLowerCase()) && VIMEO_VIDEO_PATH.test(u.pathname),
    oembedUrl: (raw) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(raw)}`
  },
  {
    name: 'Spotify',
    matches: (u) => u.hostname.toLowerCase() === 'open.spotify.com' && SPOTIFY_PATH.test(u.pathname),
    oembedUrl: (raw) => `https://open.spotify.com/oembed?url=${encodeURIComponent(raw)}`
  }
];

export interface DetectedEmbed {
  provider: EmbedProvider;
  url: string;
}

// Bare-URL scan; `<` stops us swallowing markup if any ever leaks into content.
const URL_RE = /https?:\/\/[^\s<]+/g;
// Trailing punctuation that's almost always sentence syntax, not part of the URL.
const TRAILING = /[).,!?;:'"]+$/;
/** Hard cap so a message stuffed with links can't fan out into dozens of
 * cross-origin fetches. Discord shows ~5; 3 is plenty for a chat line. */
const MAX_EMBEDS = 3;

/** Scan message content for provider links and return up to {@link MAX_EMBEDS}
 * distinct previews, first-seen order. Pure — safe to call from `$derived`. */
export function detectEmbeds(content: string): DetectedEmbed[] {
  if (!content) return [];
  const out: DetectedEmbed[] = [];
  const seen = new Set<string>();
  for (const raw of content.match(URL_RE) ?? []) {
    const url = raw.replace(TRAILING, '');
    if (seen.has(url)) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const provider = PROVIDERS.find((p) => p.matches(parsed));
    if (!provider) continue;
    seen.add(url);
    out.push({ provider, url });
    if (out.length >= MAX_EMBEDS) break;
  }
  return out;
}
