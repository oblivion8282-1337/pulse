<!--
  StreamGrid — die Video-Tile-Spalte eines Voice-Channels mit aktiven Streams.

  Mountet pro Tile-Kind nur was der Viewer explizit über die Sidebar- oder
  Voice-Tile-Badges geöffnet hat (`openedTiles`). Schliessen läuft pro Tile
  über ein Close-X; das "Alle schließen"-Sammel-X sitzt im VoiceChannelView-
  Header. Detached Tiles erscheinen NICHT als Placeholder — andocken läuft
  über den "Wieder andocken"-Button im Popup-Fenster selbst.
-->
<script lang="ts">
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import WhepPlayer from '$lib/stream/components/WhepPlayer.svelte';
  import ScreenShareTile from './ScreenShareTile.svelte';
  import CameraTile from './CameraTile.svelte';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import WatchPartyTile from './WatchPartyTile.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { userCache } from '$lib/stores/users.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  // What the viewer has actually opened, in this channel, per kind.
  // Detached tiles are excluded — they're showing in a separate window.
  let openHqIds = $derived(
    streamPresence
      .streamersIn(channel.id)
      .filter(
        (uid) =>
          uid !== auth.user?.id &&
          openedTiles.isOpen('hq', channel.id, uid) &&
          !detachedStreams.has(channel.id, uid)
      )
  );
  let openScreens = $derived(
    voice.screenTracks.filter((s) => openedTiles.isOpen('screen', channel.id, s.identity))
  );
  let openCameras = $derived(
    voice.cameraTracks.filter((c) => openedTiles.isOpen('cam', channel.id, c.identity))
  );
  let watchPartyState = $derived(watchPartyPresence.partyIn(channel.id));
  let showParty = $derived(
    !!watchPartyState &&
      openedTiles.isOpenParty(channel.id) &&
      !detachedWatchParties.has(channel.id)
  );

  // Header label: show that *something* is HQ-streaming (rocket icon + label)
  // when any HQ stream is live in the channel, regardless of whether the
  // viewer has opened the tile yet — keeps the "X streamt (HQ)" hint visible.
  let hqStreamers = $derived(streamPresence.streamersIn(channel.id));
  let iAmHqStreaming = $derived(!!auth.user && hqStreamers.includes(auth.user.id));
  let hqStreamersOther = $derived(hqStreamers.filter((uid) => uid !== auth.user?.id));
  let hqLabel = $derived.by(() => {
    const others = hqStreamersOther.length;
    if (iAmHqStreaming) {
      if (others === 0) return 'Du streamst (HQ)';
      if (others === 1) return `Du und ${userCache.displayName(hqStreamersOther[0])} streamen (HQ)`;
      return `Du und ${others} weitere streamen (HQ)`;
    }
    if (others === 1) return `${userCache.displayName(hqStreamersOther[0])} streamt (HQ)`;
    return `${others} Leute streamen (HQ)`;
  });
  let hqStreaming = $derived(hqStreamers.length > 0);

  let videoTileCount = $derived(
    openHqIds.length + openScreens.length + openCameras.length + (showParty ? 1 : 0)
  );
  // Inline grid-template-columns — Tailwind's class-interpolation could leave
  // stale `grid-cols-2` behind after a detach drops the count to 1, so we use
  // a direct style binding instead. `max(1, …)` keeps the grid valid when the
  // viewer just closed everything (videoTileCount briefly 0 before unmount).
  let gridColumns = $derived.by(() => {
    const cols = videoTileCount <= 1 ? 1 : videoTileCount <= 4 ? 2 : videoTileCount <= 9 ? 3 : 4;
    return `repeat(${cols}, minmax(0, 1fr))`;
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3" data-testid="stream-area">
  {#if hqStreaming}
    <div class="flex shrink-0 items-center gap-2 text-sm" data-testid="hq-stream-label">
      <RocketIcon class="size-4 text-red-500" />
      <span class="text-text-bright">{hqLabel}</span>
    </div>
  {/if}

  <div
    class="grid min-h-0 flex-1 auto-rows-fr gap-2"
    style="grid-template-columns: {gridColumns};"
    data-testid="stream-grid"
  >
    {#if showParty}
      <WatchPartyTile channelId={channel.id} party={watchPartyState!} />
    {/if}
    {#each openHqIds as uid (uid)}
      <WhepPlayer channelId={channel.id} userId={uid} name={userCache.displayName(uid)} />
    {/each}
    {#each openScreens as st (st.identity)}
      <ScreenShareTile
        channelId={channel.id}
        streamerId={userIdFromIdentity(st.identity)}
        track={st.track}
        audioTrack={st.audioTrack}
        name={st.name}
        identity={st.identity}
      />
    {/each}
    {#each openCameras as ct (ct.identity)}
      <CameraTile
        channelId={channel.id}
        track={ct.track}
        name={ct.name}
        identity={ct.identity}
      />
    {/each}
  </div>

  <div class="flex shrink-0 flex-wrap items-center justify-center gap-3 py-1" data-testid="voice-participants">
    {#each voice.participants as p (p.identity)}
      <VoiceParticipantTile {p} channelId={channel.id} guildId={channel.guild_id} />
    {/each}
  </div>
</div>
