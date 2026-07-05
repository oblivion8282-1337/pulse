/**
 * HQ-stream tile identity + open helpers.
 *
 * A user can run several HQ streams at once (slots 0, 1, …) — each is its own
 * viewer tile. `openedTiles` (and the anchor / focus stores) key a tile by a
 * single opaque `id`; for HQ that id is the composite `"<userId>:<slot>"`, so
 * two streams from the same user get two distinct tiles. `userId` is a
 * snowflake (digits only), so splitting on the last `:` is unambiguous.
 */
import { openedTiles } from './openedTiles.svelte';
import { detachedStreams } from './detach.svelte';
import { streamPresence } from '$lib/stores/streamPresence.svelte';
import { streamPicker, type StreamPickEntry } from './streamPicker.svelte';

/** The composite HQ tile id for one of a user's streams. */
export const hqTileId = (userId: string, slot: number): string => `${userId}:${slot}`;

/** Split a composite HQ tile id back into `(userId, slot)`. A bare userId (no
 *  `:` — older entries) resolves to slot 0. */
export function parseHqTileId(id: string): { userId: string; slot: number } {
  const i = id.lastIndexOf(':');
  if (i < 0) return { userId: id, slot: 0 };
  const slot = Number(id.slice(i + 1));
  return { userId: id.slice(0, i), slot: Number.isInteger(slot) ? slot : 0 };
}

/** Open one slot's HQ tile — focuses its detached popup if any, else opens the
 *  inline tile. Used by the per-slot entries `chooseHqForUser` builds. */
function openSlot(channelId: string, userId: string, slot: number): void {
  if (detachedStreams.has(channelId, userId, slot)) {
    detachedStreams.open(channelId, userId, slot); // focuses the existing popup
  } else {
    openedTiles.open('hq', channelId, hqTileId(userId, slot));
  }
}

/**
 * Open one of `userId`'s HQ streams: a single stream opens directly (no dialog),
 * several pop the stream picker so the viewer can pick which slot to watch (or
 * "Alle ansehen" for all of them). `title` labels the dialog. Mirrors the
 * watch-party `openParty`/`watchPartyPicker` flow — `streamPicker.choose` does
 * the 1-vs-many branching, so this just builds the entries.
 */
export function chooseHqForUser(channelId: string, userId: string, title = 'Stream ansehen'): void {
  const mine = streamPresence.streamsIn(channelId).filter((s) => s.user_id === userId);
  // Fallback to a single slot-0 entry so a click always opens at least the
  // primary tile when no slot info is set.
  const streams = mine.length ? mine : [{ user_id: userId, slot: 0 }];
  const entries: StreamPickEntry[] = streams.map((s) => ({
    slot: s.slot,
    label: s.label ?? `Stream ${s.slot + 1}`,
    open: () => openSlot(channelId, userId, s.slot),
  }));
  streamPicker.choose(entries, title);
}
