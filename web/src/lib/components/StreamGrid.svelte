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
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import WhepPlayer from '$lib/stream/components/WhepPlayer.svelte';
  import ScreenShareTile from './ScreenShareTile.svelte';
  import CameraTile from './CameraTile.svelte';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import WatchPartyTile from './WatchPartyTile.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { hiddenTiles } from '$lib/stream/hiddenTiles.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { gateway } from '$lib/ws/connection';
  import type { Channel } from '$lib/api/types';
  import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';

  let {
    channel,
    hqStreaming,
    hqStreamersOther,
    hqLabel,
    watchPartyState,
    focusUid = null
  }: {
    channel: Channel;
    hqStreaming: boolean;
    hqStreamersOther: string[];
    hqLabel: string;
    /** Aktive Watch-Party im selben Channel (parallel zu HQ/Screenshare). */
    watchPartyState?: WatchPartyState;
    /** Wenn gesetzt, blendet das Grid nur Kacheln dieses Users ein
     *  (Watch-Party-Tile nur wenn dieser User Host ist). */
    focusUid?: string | null;
  } = $props();

  // Im Fokus-Modus: nur die Kacheln des Ziel-Users zeigen. Sonst alles aus
  // diesem Channel das nicht lokal versteckt wurde.
  let focusedHq = $derived(focusUid ? hqStreamersOther.filter((u) => u === focusUid) : hqStreamersOther);
  let focusedScreen = $derived(
    voice.screenTracks.filter(
      (s) =>
        !hiddenTiles.has('screen', channel.id, s.identity) &&
        (!focusUid || userIdFromIdentity(s.identity) === focusUid)
    )
  );
  let focusedCameras = $derived(
    voice.cameraTracks.filter(
      (c) =>
        !hiddenTiles.has('cam', channel.id, c.identity) &&
        (!focusUid || userIdFromIdentity(c.identity) === focusUid)
    )
  );
  let focusedParty = $derived(
    watchPartyState && (!focusUid || watchPartyState.host_user_id === focusUid)
      ? watchPartyState
      : undefined
  );
  let videoTileCount = $derived(
    focusedHq.length +
      focusedScreen.length +
      focusedCameras.length +
      (focusedParty ? 1 : 0)
  );
  let iAmWatchPartyHost = $derived(
    !!focusedParty && !!auth.user && focusedParty.host_user_id === auth.user.id
  );
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
  {#if hqStreaming}
    <div class="flex shrink-0 items-center gap-2 text-sm" data-testid="hq-stream-label">
      <RocketIcon class="size-4 text-red-500" />
      <span class="text-text-bright">{hqLabel}</span>
    </div>
  {/if}

  {#if videoTileCount === 0 && focusUid}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-bg-chat text-center" data-testid="focused-empty">
      <p class="text-text-bright text-sm font-medium">{userCache.displayName(focusUid)} sendet hier gerade nichts</p>
      <p class="text-text-muted text-xs">Vermutlich gerade beendet.</p>
    </div>
  {:else if videoTileCount === 0}
    <!-- our own HQ stream, nothing else to show — just the "you're streaming" notice -->
    <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-bg-chat text-center" data-testid="hq-stream-self-indicator">
      <RocketIcon class="size-10 text-red-500" />
      <p class="text-text-bright text-sm font-medium">Du streamst in diesen Kanal</p>
      <p class="text-text-muted text-xs">Deine eigene Wiedergabe wird hier nicht angezeigt.</p>
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 auto-rows-fr gap-2 {streamGridCols}" data-testid="stream-grid">
      {#if focusedParty}
        {#if detachedWatchParties.has(channel.id)}
          <div
            class="border-border bg-bg-chat flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-6 text-center"
            data-testid="watch-party-detached-placeholder"
            data-channel-id={channel.id}
          >
            <ExternalLinkIcon class="text-text-muted size-10 opacity-50" />
            <p class="text-text-bright text-sm font-medium">Watch Party in eigenem Fenster</p>
            <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onclick={() => detachedWatchParties.open(channel.id)}
                class="bg-bg-hover border-border text-text rounded-full border px-3 py-1 text-xs hover:text-primary"
              >Fenster fokussieren</button>
              <button
                type="button"
                onclick={() => detachedWatchParties.reattach(channel.id)}
                class="bg-primary hover:bg-primary/90 rounded-full px-3 py-1 text-xs font-semibold text-white"
              >Wieder andocken</button>
              {#if iAmWatchPartyHost}
                <button
                  type="button"
                  onclick={() => gateway.stopWatchParty(channel.id)}
                  class="bg-destructive hover:bg-destructive/90 rounded-full px-3 py-1 text-xs font-semibold text-white"
                  data-testid="watch-party-detached-stop"
                >Watch Party beenden</button>
              {/if}
            </div>
          </div>
        {:else}
          <WatchPartyTile channelId={channel.id} party={focusedParty} />
        {/if}
      {/if}
      {#each focusedHq as uid (uid)}
        {#if detachedStreams.has(channel.id, uid)}
          <div
            class="border-border bg-bg-chat flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-6 text-center"
            data-testid="hq-stream-detached-placeholder"
            data-channel-id={channel.id}
            data-user-id={uid}
          >
            <ExternalLinkIcon class="text-text-muted size-10 opacity-50" />
            <p class="text-text-bright text-sm font-medium">Stream in eigenem Fenster</p>
            <p class="text-text-muted text-xs">{userCache.displayName(uid)}</p>
            <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onclick={() => detachedStreams.open(channel.id, uid)}
                class="bg-bg-hover border-border text-text rounded-full border px-3 py-1 text-xs hover:text-primary"
              >Fenster fokussieren</button>
              <button
                type="button"
                onclick={() => detachedStreams.reattach(channel.id, uid)}
                class="bg-primary hover:bg-primary/90 rounded-full px-3 py-1 text-xs font-semibold text-white"
              >Wieder andocken</button>
            </div>
          </div>
        {:else}
          <WhepPlayer channelId={channel.id} userId={uid} name={userCache.displayName(uid)} />
        {/if}
      {/each}
      {#each focusedScreen as st (st.identity)}
        <ScreenShareTile
          channelId={channel.id}
          streamerId={userIdFromIdentity(st.identity)}
          track={st.track}
          audioTrack={st.audioTrack}
          name={st.name}
          identity={st.identity}
        />
      {/each}
      {#each focusedCameras as ct (ct.identity)}
        <CameraTile
          channelId={channel.id}
          track={ct.track}
          name={ct.name}
          identity={ct.identity}
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
