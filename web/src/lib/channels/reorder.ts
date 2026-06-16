/**
 * Channel drag-and-drop reorder. Moving a channel only ever reshuffles its own
 * same-type group (text or voice) — the two groups are rendered separately, so
 * they share the position space without needing to agree on a global order.
 *
 * Optimistically updates the guilds store (top = position 0) so the sidebar
 * re-sorts immediately, then persists via the API. The server fans out a
 * `channel_updated` per channel, which the WS handler applies again
 * (idempotent) for every other connected member.
 */
import { chatApi } from '$lib/api/chat';
import { guilds } from '$lib/stores/guilds.svelte';
import type { Channel } from '$lib/api/types';

/** Reorder `sourceId` to where `targetId` sits within `group`, persist + sync. */
export async function reorderChannel(
  group: Channel[],
  sourceId: string,
  targetId: string,
  guildId: string
): Promise<void> {
  if (sourceId === targetId) return;
  const fromIdx = group.findIndex((c) => c.id === sourceId);
  const toIdx = group.findIndex((c) => c.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;

  const reordered = [...group];
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(toIdx, 0, moved);

  const updates = reordered.map((c, i) => ({ id: c.id, position: i }));
  // Optimistic: re-sort the sidebar now (the broadcast confirms it later).
  for (const u of updates) {
    guilds.updateChannel({ id: u.id, guild_id: guildId, position: u.position });
  }
  const rows = await chatApi.setChannelPositions(guildId, updates);
  for (const r of rows) guilds.updateChannel(r);
}
