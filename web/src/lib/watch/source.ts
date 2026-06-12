/**
 * Client-side mirror of the backend `watch_source.parse_source`.
 *
 * Used by the start-party popover to give the user instant feedback as they
 * paste a URL — the backend re-validates with its own copy, so this can be
 * leaner about edge cases.
 */

import type { WatchSource } from '$lib/stores/watchPartyPresence.svelte';

const MAX_URL_LEN = 2048;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_VOD_PATH = /^\/videos\/(\d+)\/?$/;
const TWITCH_CHANNEL_NAME = /^[A-Za-z0-9_]{1,25}$/;
const NATIVE_SUFFIX = /\.(mp4|webm)$/i;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'www.youtube-nocookie.com'
]);

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']);

// Keep in sync with _TWITCH_RESERVED_PATHS in watch_source.py (backend is
// the authority — this is just for fast UI feedback).
const TWITCH_RESERVED_PATHS = new Set([
  'videos',
  'directory',
  'p',
  'user',
  'users',
  'legal',
  'admin',
  'login',
  'signup',
  'logout',
  'jobs',
  'team',
  'teams',
  'subscriptions',
  'friends',
  'inventory',
  'wallet',
  'downloads',
  'search',
  'settings',
  'moderator',
  'following',
  'followers',
  'popout',
  'embed',
  'clip',
  'clips',
  'collections',
  'creatorcamp',
  'turbo',
  'prime',
  'drops',
  'store',
  'broadcast',
  'dashboard'
]);

function parseT(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || m.slice(1).every((g) => !g)) return undefined;
  const h = Number(m[1] ?? 0);
  const mn = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return h * 3600 + mn * 60 + s;
}

function startSeconds(params: URLSearchParams): number | undefined {
  for (const k of ['t', 'start']) {
    const v = parseT(params.get(k));
    if (v !== undefined) return v;
  }
  return undefined;
}

function youtube(vid: string, params: URLSearchParams): WatchSource {
  const out: WatchSource = { type: 'youtube', embed_id: vid };
  const s = startSeconds(params);
  if (s !== undefined) out.start_seconds = s;
  return out;
}

export function parseSource(input: string): WatchSource | null {
  if (typeof input !== 'string') return null;
  const url = input.trim();
  if (!url || url.length > MAX_URL_LEN) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const params = u.searchParams;

  // YouTube
  if (host === 'youtu.be') {
    const vid = u.pathname.replace(/^\//, '').split('/', 1)[0];
    return YOUTUBE_ID.test(vid) ? youtube(vid, params) : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    let vid: string | undefined;
    if (u.pathname === '/watch') {
      vid = params.get('v') ?? undefined;
    } else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/')) {
      vid = u.pathname.split('/', 3)[2]?.split('/')[0];
    }
    return vid && YOUTUBE_ID.test(vid) ? youtube(vid, params) : null;
  }

  // Twitch VOD + live channel.
  if (TWITCH_HOSTS.has(host)) {
    const m = u.pathname.match(TWITCH_VOD_PATH);
    if (m) {
      const out: WatchSource = { type: 'twitch', embed_id: m[1] };
      const s = startSeconds(params);
      if (s !== undefined) out.start_seconds = s;
      return out;
    }
    // Live channel: single path segment, not reserved, matches name regex.
    // Multi-segment paths (clips, /v/, /clip/) are intentionally not v1.
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 1) {
      const name = parts[0];
      if (!TWITCH_RESERVED_PATHS.has(name.toLowerCase()) && TWITCH_CHANNEL_NAME.test(name)) {
        return { type: 'twitch_live', channel: name };
      }
    }
    return null;
  }

  // Native — direct https URL ending in mp4/webm. HLS (.m3u8) is not accepted:
  // the player is a plain <video> and Chromium/Electron can't play HLS natively.
  if (NATIVE_SUFFIX.test(u.pathname)) {
    return { type: 'native', url };
  }

  return null;
}
