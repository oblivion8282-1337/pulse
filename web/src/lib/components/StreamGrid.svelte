<!--
  StreamGrid — die Video-Tile-Spalte eines Voice-Channels mit aktiven Streams.

  Mountet pro Tile-Kind nur was der Viewer explizit über die Sidebar- oder
  Voice-Tile-Badges geöffnet hat (`openedTiles`). Schliessen läuft pro Tile
  über ein Close-X; das "Alle schließen"-Sammel-X sitzt im VoiceChannelView-
  Header. Detached Tiles erscheinen NICHT als Placeholder.

  Layout: Raster (gleich große Kacheln) ODER Fokus-Modus — eine Kachel groß,
  der Rest als Filmstrip-Zeile darunter. Umschalten über den Fokus-Button im
  jeweiligen Tile-HUD. Alle Kacheln liegen in EINEM Grid-Container, damit ein
  Fokus-Wechsel nur Grid-Platzierung + `compact` umschaltet — die Tile-
  Komponenten bleiben gemountet (kein WHEP-/LiveKit-Neuaufbau).
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
  import { viewport } from '$lib/stores/viewport.svelte';
  import { untrack } from 'svelte';
  import type { Channel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

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
      if (others === 0) return m.stream_grid_hq_you_only();
      if (others === 1) return m.stream_grid_hq_you_and_one({ name: userCache.displayName(hqStreamersOther[0]) });
      return m.stream_grid_hq_you_and_others({ count: others });
    }
    if (others === 1) return m.stream_grid_hq_one_other({ name: userCache.displayName(hqStreamersOther[0]) });
    return m.stream_grid_hq_many_others({ count: others });
  });
  let hqStreaming = $derived(hqStreamers.length > 0);

  // Stabile Tile-Keys in Render-Reihenfolge (Party · HQ · Screens · Cams).
  let tileKeys = $derived([
    ...(showParty ? ['party'] : []),
    ...openHqIds.map((u) => `hq:${u}`),
    ...openScreens.map((s) => `screen:${s.identity}`),
    ...openCameras.map((c) => `cam:${c.identity}`)
  ]);
  let videoTileCount = $derived(tileKeys.length);

  // --- Fokus-Modus -----------------------------------------------------
  // `focusedKey` ist der Wunsch; `focusMode` prüft zusätzlich, dass es ≥2
  // Kacheln gibt und die fokussierte noch existiert (sonst Raster).
  let focusedKey = $state<string | null>(null);
  let focusMode = $derived(
    focusedKey !== null && videoTileCount > 1 && tileKeys.includes(focusedKey)
  );

  // Fokus bei Channel-Wechsel zurücksetzen.
  $effect(() => {
    channel.id;
    untrack(() => {
      focusedKey = null;
    });
  });

  /** Handler für den Fokus-Umschalter eines Tiles. Bei nur einer Kachel:
   *  undefined → kein Button. */
  function focusHandler(key: string): (() => void) | undefined {
    if (videoTileCount <= 1) return undefined;
    return () => {
      focusedKey = focusMode && focusedKey === key ? null : key;
    };
  }
  /** Inline-Grid-Platzierung: die fokussierte Kachel spannt die obere Zeile. */
  function cellStyle(key: string): string {
    return focusMode && focusedKey === key ? 'grid-column: 1 / -1; grid-row: 1;' : '';
  }

  // Inline grid-template — Tailwind-Klassen-Interpolation könnte stale
  // `grid-cols-*` zurücklassen, daher direkt als Style-Binding.
  let gridStyle = $derived.by(() => {
    if (focusMode) {
      const n = Math.max(1, videoTileCount - 1);
      const strip = viewport.isMobile ? '4.75rem' : '6.5rem';
      return `grid-template-columns: repeat(${n}, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr) ${strip};`;
    }
    // Mobil: immer 1 Spalte; mehrere Tiles teilen sich die Höhe (auto-rows-fr).
    if (viewport.isMobile) return 'grid-template-columns: minmax(0, 1fr);';
    const cols =
      videoTileCount <= 1 ? 1 : videoTileCount <= 4 ? 2 : videoTileCount <= 9 ? 3 : 4;
    return `grid-template-columns: repeat(${cols}, minmax(0, 1fr));`;
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
    class="grid min-h-0 flex-1 gap-2 {focusMode ? '' : 'auto-rows-fr'}"
    style={gridStyle}
    data-testid="stream-grid"
    data-focus-mode={focusMode}
  >
    {#if showParty}
      <div class="min-h-0 min-w-0" style={cellStyle('party')}>
        <WatchPartyTile
          channelId={channel.id}
          party={watchPartyState!}
          compact={focusMode && focusedKey !== 'party'}
          focused={focusMode && focusedKey === 'party'}
          onToggleFocus={focusHandler('party')}
        />
      </div>
    {/if}
    {#each openHqIds as uid (uid)}
      {@const key = `hq:${uid}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <WhepPlayer
          channelId={channel.id}
          userId={uid}
          name={userCache.displayName(uid)}
          compact={focusMode && focusedKey !== key}
          focused={focusMode && focusedKey === key}
          onToggleFocus={focusHandler(key)}
        />
      </div>
    {/each}
    {#each openScreens as st (st.identity)}
      {@const key = `screen:${st.identity}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <ScreenShareTile
          channelId={channel.id}
          streamerId={userIdFromIdentity(st.identity)}
          track={st.track}
          audioTrack={st.audioTrack}
          name={st.name}
          identity={st.identity}
          compact={focusMode && focusedKey !== key}
          focused={focusMode && focusedKey === key}
          onToggleFocus={focusHandler(key)}
        />
      </div>
    {/each}
    {#each openCameras as ct (ct.identity)}
      {@const key = `cam:${ct.identity}`}
      <div class="min-h-0 min-w-0" style={cellStyle(key)}>
        <CameraTile
          channelId={channel.id}
          track={ct.track}
          name={ct.name}
          identity={ct.identity}
          compact={focusMode && focusedKey !== key}
          focused={focusMode && focusedKey === key}
          onToggleFocus={focusHandler(key)}
        />
      </div>
    {/each}
  </div>

  <div
    class="flex shrink-0 flex-wrap items-center justify-center gap-3 py-1"
    data-testid="voice-participants"
  >
    {#each voice.participants as p (p.identity)}
      <VoiceParticipantTile {p} channelId={channel.id} guildId={channel.guild_id} />
    {/each}
  </div>
</div>
