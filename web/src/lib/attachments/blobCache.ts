/**
 * Object-URL cache for attachment images, shared across mounts.
 *
 * Why this exists: the message list is virtualised, so an image message is
 * unmounted the moment it leaves the render window and re-mounted when it
 * comes back — many times during a single scroll gesture. Without a cache
 * every remount re-ran the whole fetch → blob → `createObjectURL` dance
 * (measured: 85 re-fetches for 6 images in one scroll up-down-up pass), and
 * the image was *absent* until it finished, i.e. it visibly flickered.
 *
 * Entries are ref-counted. A released entry is not revoked immediately but
 * parked in an LRU list, so a remount seconds later is instant. Only when the
 * parked list exceeds `MAX_PARKED` is the oldest URL revoked — an in-use URL
 * (refs > 0) is never revoked, so a live `<img src>` can't break.
 */

type Entry = { url: string; refs: number };

/** Parked (refs === 0) entries kept around for a quick remount. Sized to
 *  comfortably cover a screenful of images plus scroll buffer on both sides. */
const MAX_PARKED = 48;

const entries = new Map<string, Entry>();
/** Keys with refs === 0, least-recently-released first. */
const parked: string[] = [];

function unpark(key: string): void {
  const i = parked.indexOf(key);
  if (i !== -1) parked.splice(i, 1);
}

function evictParked(): void {
  while (parked.length > MAX_PARKED) {
    const key = parked.shift()!;
    const entry = entries.get(key);
    // Guard: only ever revoke something nobody holds.
    if (!entry || entry.refs > 0) continue;
    URL.revokeObjectURL(entry.url);
    entries.delete(key);
  }
}

/** Cached object URL for `key`, or null if it has not been loaded yet.
 *  Increments the ref count when it hits — pair every hit with `release`. */
export function acquire(key: string): string | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.refs++;
  unpark(key);
  return entry.url;
}

/** Store a freshly created object URL under `key`, held by the caller
 *  (ref count 1). If `key` is already present the new URL is redundant —
 *  it gets revoked and the existing one is returned (and held) instead. */
export function store(key: string, url: string): string {
  const existing = acquire(key);
  if (existing) {
    if (existing !== url) URL.revokeObjectURL(url);
    return existing;
  }
  entries.set(key, { url, refs: 1 });
  return url;
}

/** Give up one hold on `key`. At zero holders the entry is parked for reuse
 *  rather than revoked; eviction happens once the park list is full. */
export function release(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  // unpark first: an unbalanced release must not park the same key twice.
  unpark(key);
  parked.push(key);
  evictParked();
}

/** Drop everything (sign-out / account switch — blobs may be private). */
export function clearBlobCache(): void {
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url);
  entries.clear();
  parked.length = 0;
}
