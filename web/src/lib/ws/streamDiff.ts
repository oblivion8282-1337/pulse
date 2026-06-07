/**
 * Fires join/leave sounds for HQ streams in *our* channels.
 *
 * Pattern is the same as `voiceDiff.ts` — diff the old and new
 * ``user_ids`` set and play the appropriate sound per delta, skipping
 * the local user. A fresh starter whose uid is ``me`` triggers the
 * self-start confirmation tone instead of the generic user-start
 * sound; there is intentionally no ``stream.self_stop`` because the
 * streamer has first-hand visual feedback (the GSR sidecar state
 * already drives the controls bar) and a "you stopped" ping is just
 * noise.
 *
 * We deliberately do NOT filter by currently-open channel the way a
 * UI notification might — the server already broadcasts ``stream_state``
 * only to sockets that pass ``_filter_by_view_channel`` for the
 * channel, so each sound fired here is unambiguously "in a channel I'm
 * allowed to see". One stream start → one sound per subscribed client,
 * no extra store lookup required.
 */
import { sounds } from '$lib/sounds/engine';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';

export function fireStreamDiff(channelId: string, oldIds: string[], newIds: string[]): void {
  const me = currentServerUserId();
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const gid = guilds.guildIdForChannel(channelId);
  for (const uid of newIds) {
    if (oldSet.has(uid)) continue;
    if (uid === me) {
      sounds.play('stream.self_start', { guildId: gid });
    } else {
      sounds.play('stream.user_start', { guildId: gid });
    }
  }
  for (const uid of oldIds) {
    if (newSet.has(uid) || uid === me) continue;
    sounds.play('stream.user_stop', { guildId: gid });
  }
}
