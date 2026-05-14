<!--
  StreamGrid — die Video-Tile-Spalte eines Voice-Channels mit aktiven Streams.

  Zeigt für jeden fremden HQ-Streamer einen WhepPlayer plus für jeden LiveKit-
  Screen-Share einen ScreenShareTile in einem responsiven Grid. Wenn nur der
  lokale User selbst HQ-streamt (kein Tile zum Anzeigen), erscheint stattdessen
  ein "Du streamst"-Indikator. Darunter eine Reihe Voice-Teilnehmer-Tiles.

  Extrahiert aus VoiceChannelView.svelte, damit der HQ-Live-Chat-Pfad noch
  Platz im Parent hat (Größen-Policy, 250 Z. Limit).
-->
<script lang="ts">
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import XIcon from '@lucide/svelte/icons/x';
  import WhepPlayer from '$lib/stream/components/WhepPlayer.svelte';
  import ScreenShareTile from './ScreenShareTile.svelte';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { userCache } from '$lib/stores/users.svelte';
  import type { Channel } from '$lib/api/types';

  let {
    channel,
    hqStreaming,
    hqStreamersOther,
    hqLabel,
    onClose
  }: {
    channel: Channel;
    hqStreaming: boolean;
    hqStreamersOther: string[];
    hqLabel: string;
    /** Wenn gesetzt: kleiner Schließen-Button oben rechts, der zur Teilnehmer-
     *  Ansicht zurückkehrt. Ohne diesen Hook ist das Grid permanent (z.B. wenn
     *  in einem anderen Layout-Kontext gemountet). */
    onClose?: () => void;
  } = $props();

  let videoTileCount = $derived(hqStreamersOther.length + voice.screenTracks.length);
  let streamGridCols = $derived(
    videoTileCount <= 1
      ? 'grid-cols-1'
      : videoTileCount <= 4
        ? 'grid-cols-2'
        : videoTileCount <= 9
          ? 'grid-cols-3'
          : 'grid-cols-4',
  );
</script>

<div class="relative flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3" data-testid="stream-area">
  {#if onClose}
    <button
      type="button"
      onclick={onClose}
      class="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-black/55 px-3 py-1 text-xs text-white backdrop-blur-sm hover:bg-black/75"
      aria-label="Stream beenden"
      title="Stream beenden"
      data-testid="stream-grid-close"
    >
      <XIcon class="size-3.5" />
      <span class="hidden sm:inline">Stream beenden</span>
    </button>
  {/if}
  {#if hqStreaming}
    <div class="flex shrink-0 items-center gap-2 text-sm" data-testid="hq-stream-label">
      <RocketIcon class="size-4 text-red-500" />
      <span class="text-text-bright">{hqLabel}</span>
    </div>
  {/if}

  {#if videoTileCount === 0}
    <!-- our own HQ stream, nothing else to show — just the "you're streaming" notice -->
    <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-bg-chat text-center" data-testid="hq-stream-self-indicator">
      <RocketIcon class="size-10 text-red-500" />
      <p class="text-text-bright text-sm font-medium">Du streamst in diesen Kanal</p>
      <p class="text-text-muted text-xs">Deine eigene Wiedergabe wird hier nicht angezeigt.</p>
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 auto-rows-fr gap-2 {streamGridCols}" data-testid="stream-grid">
      {#each hqStreamersOther as uid (uid)}
        <WhepPlayer channelId={channel.id} userId={uid} name={userCache.displayName(uid)} />
      {/each}
      {#each voice.screenTracks as st (st.identity)}
        <ScreenShareTile
          channelId={channel.id}
          streamerId={userIdFromIdentity(st.identity)}
          track={st.track}
          audioTrack={st.audioTrack}
          name={st.name}
          identity={st.identity}
        />
      {/each}
    </div>
  {/if}

  <div class="flex shrink-0 flex-wrap items-center justify-center gap-3 py-1" data-testid="voice-participants">
    {#each voice.participants as p (p.identity)}
      <VoiceParticipantTile {p} />
    {/each}
  </div>
</div>
