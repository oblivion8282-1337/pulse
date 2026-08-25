<!--
  WatchBackgroundHost — single persistent owner of every open watch-party player.
  Mounted once in app/+layout.svelte so it survives all navigation. Each open,
  live, non-detached party is mounted exactly once here; WatchBackgroundFrame
  positions it over the StreamGrid anchor (docked) or as a fixed corner window
  (when you've navigated away but stay in that voice channel). Because the tile
  never unmounts on navigation, its <video>/iframe keeps playing — audio and all.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { voiceState } from '$lib/voice/state.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { watchBackground } from './watchBackground.svelte';
  import WatchBackgroundFrame from './WatchBackgroundFrame.svelte';
  import WatchPartyTile from '$lib/components/WatchPartyTile.svelte';

  // Every open party that is still live and not detached into a popup.
  let shown = $derived(
    watchBackground
      .openParties()
      .map((o) => ({ ...o, party: watchPartyPresence.partyIn(o.channelId, o.partyId) }))
      .filter((o) => o.party && !detachedWatchParties.has(o.channelId, o.partyId))
  );

  // Close an open party once it is NEITHER viewed (no anchor) NOR in voice. The
  // navigate-away-while-not-in-voice case is closed by the anchor action's
  // cleanup in StreamGrid (fires on real unmount, so it can't race the initial
  // open). This effect covers the other transition: the connected voice channel
  // changes / drops, so background (non-viewed) parties in the channel we left
  // lose their reason to stay. A still-viewed channel keeps its party (matches
  // main: a viewed voice channel shows its party even when not connected).
  let prevVoice: string | null = null;
  $effect(() => {
    const cur = voiceState.connected ? voiceState.channelId : null;
    const prev = prevVoice;
    prevVoice = cur;
    if (!prev || prev === cur) return;
    for (const o of watchBackground.openParties()) {
      if (o.channelId === prev && watchBackground.anchorRect(o.channelId, o.partyId) === null) {
        watchBackground.closeParty(o.channelId, o.partyId);
      }
    }
  });

  function returnTo(channelId: string): void {
    const guildId = guilds.guildIdForChannel(channelId);
    if (guildId) goto(`/app/guilds/${guildId}/channels/${channelId}`);
  }
</script>

{#each shown as o, i (o.partyId)}
  {@const rect = watchBackground.anchorRect(o.channelId, o.partyId)}
  <WatchBackgroundFrame {rect} index={i} onReturn={() => returnTo(o.channelId)}
    onClose={() => watchBackground.closeParty(o.channelId, o.partyId)}>
    <WatchPartyTile channelId={o.channelId} party={o.party!} />
  </WatchBackgroundFrame>
{/each}
