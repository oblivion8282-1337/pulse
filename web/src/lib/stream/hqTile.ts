/**
 * HQ-stream tile identity helpers.
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

/** The slots a user is currently streaming in a channel (≥ [0] as a fallback so
 *  a click always opens at least the primary tile). */
function slotsOf(channelId: string, userId: string): number[] {
  const slots = streamPresence
    .streamsIn(channelId)
    .filter((s) => s.user_id === userId)
    .map((s) => s.slot);
  return slots.length ? slots : [0];
}

/**
 * Open the HQ stream(s) of `userId` in `channelId` — a tile per live slot. A
 * slot that's already detached into a popup focuses that popup instead of
 * re-mounting inline.
 */
export function openHqForUser(channelId: string, userId: string): void {
  for (const slot of slotsOf(channelId, userId)) {
    if (detachedStreams.has(channelId, userId, slot)) {
      detachedStreams.open(channelId, userId, slot); // focuses the existing popup
    } else {
      openedTiles.open('hq', channelId, hqTileId(userId, slot));
    }
  }
}
