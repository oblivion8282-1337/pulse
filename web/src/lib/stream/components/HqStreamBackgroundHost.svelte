<!--
  HqStreamBackgroundHost — siblings `WatchBackgroundHost` and `LiveKitBackgroundHost`.
  Lives once in the app layout and renders a `WhepPlayer` per open HQ stream
  (sourced from `openedTiles`), positioned over the StreamGrid anchor (docked)
  or as a corner window when no anchor exists.

  The inline tile was removed from StreamGrid (it's now an empty anchor div);
  this is the only mount point of `WhepPlayer`. That's how the stream keeps
  running when you navigate to a text channel / DM — `HqStreamKeepAlive`
  keeps the WHEP connection alive in parallel.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { hqStreamBackground } from '$lib/stream/hqStreamBackground.svelte';
  import { streamFocus } from '$lib/stream/streamFocus.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voiceState } from '$lib/voice/state.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import WatchBackgroundFrame from '$lib/watch/WatchBackgroundFrame.svelte';
  import WhepPlayer from './WhepPlayer.svelte';

  let myId = $derived(currentServerUserId());

  // Every open, non-self, non-detached HQ stream whose publisher is currently
  // live (otherwise the tile would sit as an error placeholder when the streamer
  // goes offline). Source is `openedTiles` (opened via sidebar / voice-tile
  // badges); `HqStreamKeepAlive` uses the same list to keep connections alive.
  let shown = $derived(
    openedTiles
      .entriesOfKind('hq')
      .filter(
        (e) =>
          e.id !== myId &&
          !detachedStreams.has(e.channelId, e.id) &&
          streamPresence.streamersIn(e.channelId).includes(e.id)
      )
  );

  // Close HQ tiles that lose their reason to stay when the connected voice
  // channel changes / drops — same rationale as WatchBackgroundHost: the
  // anchor's destroy in StreamGrid only fires on a real unmount, so a
  // corner-mode tile that survived a "navigate-away-then-hang-up" sequence
  // would otherwise sit as a ghost popup. Viewed tiles (anchor present) stay
  // open.
  let prevVoice: string | null = null;
  $effect(() => {
    const cur = voiceState.connected ? voiceState.channelId : null;
    const prev = prevVoice;
    prevVoice = cur;
    if (!prev || prev === cur) return;
    for (const e of openedTiles.entriesOfKind('hq')) {
      if (
        e.channelId === prev &&
        hqStreamBackground.anchorRect(e.channelId, e.id) === null
      ) {
        openedTiles.close('hq', e.channelId, e.id);
      }
    }
  });

  function returnTo(channelId: string): void {
    const guildId = guilds.guildIdForChannel(channelId);
    if (guildId) goto(`/app/guilds/${guildId}/channels/${channelId}`);
  }
</script>

{#each shown as e, i (e.channelId + '::' + e.id)}
  {@const rect = hqStreamBackground.anchorRect(e.channelId, e.id)}
  <WatchBackgroundFrame {rect} index={i} onReturn={() => returnTo(e.channelId)}>
    <WhepPlayer
      channelId={e.channelId}
      userId={e.id}
      canDetach={true}
      canHide={true}
      compact={false}
      focused={streamFocus.isFocused(e.channelId, 'hq', e.id)}
      onToggleFocus={() => streamFocus.toggle(e.channelId, 'hq', e.id)}
    />
  </WatchBackgroundFrame>
{/each}