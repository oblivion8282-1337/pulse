/**
 * Client-side oEmbed fetch + reactive cache for inline link previews.
 *
 * Mirrors the shape of `watch/youtubeMeta.svelte.ts` (which stays as-is so the
 * watch-party title lookup is untouched) but generalised across providers and
 * carrying the full card payload. Keyed by the message URL: the same link in
 * two messages shares one fetch + one cache entry.
 *
 * Failure is cached as `null` (link stays clickable in the text, just no card)
 * so a 404 / non-video URL doesn't re-fetch on every render. `keyResolved`
 * distinguishes "looked up, nothing" from "still loading".
 */

import { SvelteMap } from 'svelte/reactivity';
import type { EmbedProvider } from './providers';

export interface OEmbedData {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  provider_name?: string;
  /** oEmbed `type`: video | photo | rich | link. */
  type?: string;
}

/** `null` = looked up, unavailable; missing key = not fetched yet. */
const cache = new SvelteMap<string, OEmbedData | null>();
const inFlight = new Set<string>();
const MAX_CACHE_SIZE = 200;

/** Fire-and-forget, idempotent per URL. Safe to call from `$effect`. */
export function prefetchEmbed(provider: EmbedProvider, url: string): void {
  if (!url || cache.has(url) || inFlight.has(url)) return;
  inFlight.add(url);
  void fetchOEmbed(provider, url);
}

/** Reactive read: the card payload, `null` if unavailable or not yet fetched.
 * Pair with {@link keyResolved} to tell loading from no-result. */
export function embedData(url: string): OEmbedData | null {
  return cache.get(url) ?? null;
}

/** Reactive read: true once the lookup has settled (success OR failure). */
export function keyResolved(url: string): boolean {
  return cache.has(url);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function fetchOEmbed(provider: EmbedProvider, url: string): Promise<void> {
  try {
    const res = await fetch(provider.oembedUrl(url), { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      store(url, null); // 4xx/5xx → not a previewable URL
      return;
    }
    const raw = (await res.json()) as Record<string, unknown>;
    // Keep only the fields the card renders, all as plain strings. The
    // component escapes text and https-validates the thumbnail, so nothing
    // here is trusted as markup.
    const data: OEmbedData = {
      title: asString(raw.title),
      author_name: asString(raw.author_name),
      thumbnail_url: asString(raw.thumbnail_url),
      provider_name: asString(raw.provider_name) ?? provider.name,
      type: asString(raw.type)
    };
    // Nothing worth showing (no title and no thumbnail) → treat as unavailable.
    store(url, data.title || data.thumbnail_url ? data : null);
  } catch {
    store(url, null); // network/parse error → no card, link still clickable
  } finally {
    inFlight.delete(url);
  }
}

function store(url: string, data: OEmbedData | null): void {
  if (cache.size >= MAX_CACHE_SIZE && !cache.has(url)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, data);
}
