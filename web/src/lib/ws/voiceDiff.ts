/**
 * Fires join/leave sounds for *other* users in *our* voice channel.
 *
 * Lifted out of `connection.ts` so the gateway stays focused on
 * lifecycle. The initial roster after our own connect arrives as a diff
 * against a snapshot that already contains those users (gateway pushed
 * `voice_state` to us as a guild member before we joined voice), so the
 * comparison naturally suppresses spurious join-sounds for the people
 * who were already there when we walked in.
 */
import { sounds } from '$lib/sounds/engine';
import { auth } from '$lib/stores/auth.svelte';
import { guilds } from '$lib/stores/guilds.svelte';

export function fireVoiceDiff(channelId: string, oldIds: string[], newIds: string[]): void {
  // Lazy import to avoid the circular dep with voice/livekit.
  void import('$lib/voice/livekit.svelte').then(({ voice }) => {
    if (voice.channelId !== channelId) return;
    const me = auth.user?.id;
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);
    const gid = guilds.guildIdForChannel(channelId);
    for (const uid of newIds) {
      if (uid !== me && !oldSet.has(uid)) sounds.play('voice.user_join', { guildId: gid });
    }
    for (const uid of oldIds) {
      if (uid !== me && !newSet.has(uid)) sounds.play('voice.user_leave', { guildId: gid });
    }
  });
}
