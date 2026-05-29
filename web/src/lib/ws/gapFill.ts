/**
 * Per-channel gap-fill helpers used by the gateway after reconnects and
 * channel-switches. Pulled out of `connection.ts` to keep the singleton
 * focused on socket lifecycle.
 *
 * Reconnect path: for each subscribed channel whose history we already
 * loaded, fetch `?after=<lastSeenId>` and merge. If a single gap
 * exceeds GAP_FILL_LIMIT (100) we drop the cache so the page-effect in
 * `routes/app/.../+page.svelte` triggers a full reload — better one
 * visible reload than a silent hole.
 *
 * Channel-switch path: gap-fill a single channel whose history was
 * loaded earlier this session. Without this, re-opening misses every
 * message that arrived while the WS subscription was dropped (the sub
 * is released on switch-away, and `loadedChannels` short-circuits the
 * REST fetch on the way back). Safe to call right after `subscribe()`:
 * a WS push racing the REST call dedupes via `mergeGap` (id + nonce).
 */
import { messages } from '$lib/stores/messages.svelte';

const GAP_FILL_LIMIT = 100;

export async function gapFillChannel(cid: string, refetchOnOverflow: boolean): Promise<void> {
  const lastId = messages.lastPersistedId(cid);
  if (!lastId) return;
  const { chatApi } = await import('$lib/api/chat');
  try {
    // Fetch the latest page rather than a bare `?after` slice: it backfills
    // new messages (`mergeGap`) AND lets `reconcile` re-sync reactions /
    // edits that landed on messages we already hold — a `?after` page
    // never sees changes on existing rows.
    const page = await chatApi.listMessages(cid, { limit: GAP_FILL_LIMIT });
    if (!page.length) return;
    // `listMessages` returns newest-first → its last entry is the oldest.
    const oldestFetched = page[page.length - 1].id;
    if (page.length >= GAP_FILL_LIMIT && oldestFetched > lastId) {
      // Even the oldest row on the page is newer than anything we hold —
      // the gap exceeds one page; older missed messages would be lost.
      if (refetchOnOverflow) {
        // Channel-switch path: no page-effect reload to fall back to, so
        // adopt the latest page as the new history.
        messages.setInitial(cid, page);
      } else {
        // Reconnect path: drop the cache so the page-effect in
        // `routes/app/.../+page.svelte` triggers a full reload.
        messages.clearChannel(cid);
      }
      return;
    }
    messages.mergeGap(cid, page);
    messages.reconcile(cid, page);
  } catch {
    // Best-effort. A 401 means the token already rotated again (unlikely
    // but possible); the next reconnect/switch will retry.
  }
}

export async function gapFillAll(subs: Iterable<string>): Promise<void> {
  await Promise.allSettled([...subs].map(cid => gapFillChannel(cid, false)));
}
