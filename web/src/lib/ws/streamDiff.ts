/**
 * Fires join/leave sounds for HQ streams in *our* channels.
 *
 * Pattern is the same as `voiceDiff.ts` — diff the old and new
 * ``user_ids`` set and play the appropriate sound per delta, skipping
 * the local user. A fresh starter whose uid is ``me`` triggers the
 * self-start confirmation tone instead of the generic user-start
 * sound; there is intentionally no ``stream.self_stop`` because the
 * streamer has first-hand visual feedback (the HQ sidecar state
 * already drives the controls bar) and a "you stopped" ping is just
 * noise.
 *
 * Scope: the cue only fires when we are **connected to the voice channel**
 * the stream belongs to (``voiceState.channelId === channelId``). The server
 * broadcasts ``stream_state`` to every socket that can VIEW_CHANNEL the path —
 * across *all* the user's communities — which is correct for the visual
 * presence badge, but as an audio cue it was far too broad (you'd hear a chime
 * for a stream in a community you aren't even looking at). Mirrors Discord:
 * you only hear it for the call you're in. Presence itself stays global; only
 * this sound is gated.
 */
import { sounds } from '$lib/sounds/engine';
import { currentServerUserId } from '$lib/stores/currentServerUser';
import { guilds } from '$lib/stores/guilds.svelte';
import { voiceState } from '$lib/voice/state.svelte';

export function fireStreamDiff(channelId: string, oldIds: string[], newIds: string[]): void {
  // Only chime for the voice channel we're actually connected to.
  if (voiceState.channelId !== channelId) return;
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
