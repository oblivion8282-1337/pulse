import { SvelteMap } from 'svelte/reactivity';

/** Resolved metadata for a YouTube embed id. `null` = looked up, not available
 *  (private/deleted/region-blocked); missing key = not yet fetched. */
type Entry = { title: string } | null;

const cache = new SvelteMap<string, Entry>();
const inFlight = new Set<string>();

/** Fire-and-forget fetch trigger — idempotent per embed id. Safe to call from
 *  `$effect`; the result lands in the reactive cache. */
export function prefetchYoutubeTitle(embedId: string): void {
  if (!embedId || cache.has(embedId) || inFlight.has(embedId)) return;
  inFlight.add(embedId);
  void fetchMeta(embedId);
}

/** Reactive read: returns the cached title or `null` while still fetching /
 *  if YouTube doesn't expose the video. Call from `$derived` after triggering
 *  `prefetchYoutubeTitle` from `$effect`. */
export function youtubeTitle(embedId: string): string | null {
  if (!embedId) return null;
  return cache.get(embedId)?.title ?? null;
}

async function fetchMeta(embedId: string): Promise<void> {
  try {
    const videoUrl = `https://youtu.be/${encodeURIComponent(embedId)}`;
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`
    );
    if (!res.ok) {
      cache.set(embedId, null);
      return;
    }
    const data = (await res.json()) as unknown;
    const title =
      data && typeof data === 'object' && 'title' in data && typeof data.title === 'string'
        ? data.title.trim()
        : '';
    cache.set(embedId, title.length > 0 ? { title } : null);
  } catch {
    cache.set(embedId, null);
  } finally {
    inFlight.delete(embedId);
  }
}
