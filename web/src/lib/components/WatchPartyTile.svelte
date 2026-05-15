<!--
  WatchPartyTile — eine aktive Watch-Party in einem Voice-Channel.

  Mountet den passenden Player (YouTube / Twitch / Native) anhand
  `party.source.type`, hängt für *Viewer* den DriftCorrector an (lokaler
  Player wird bei jedem Store-Update gegen den Host-Stand abgeglichen) und
  für den *Host* den Heartbeat (3s-Loop, broadcasted seine currentTime
  zurück). Player-Events (`play`/`pause`/`seek`) → `gateway.sendWatchControl`
  nur beim Host.

  Source/host_user_id sind während einer Party stabil; das `state`-Objekt
  ändert sich aber bei jedem Heartbeat/Control (neue position/updated_at),
  daher reagiert der Viewer-$effect auf das ganze Objekt.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import XIcon from '@lucide/svelte/icons/x';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
  import { gateway } from '$lib/ws/connection';
  import NativeVideoPlayer from '$lib/watch/players/NativeVideoPlayer.svelte';
  import TwitchPlayer from '$lib/watch/players/TwitchPlayer.svelte';
  import YouTubePlayer from '$lib/watch/players/YouTubePlayer.svelte';
  import {
    DriftCorrector,
    startHeartbeat,
    type PlayerEvent,
    type PlayerHandle
  } from '$lib/watch/sync';

  interface Props {
    channelId: string;
    party: WatchPartyState;
  }

  let { channelId, party }: Props = $props();

  let player = $state<PlayerHandle | undefined>(undefined);
  let stopHeartbeat: (() => void) | undefined;
  const corrector = new DriftCorrector();

  const isHost = $derived(!!auth.user && party.host_user_id === auth.user.id);
  const hostName = $derived(userCache.displayName(party.host_user_id));

  $effect(() => {
    userCache.queue(party.host_user_id);
  });

  // Viewer: correct drift whenever the remote state changes.
  $effect(() => {
    const p = player;
    if (!p || isHost) return;
    corrector.apply(p, party);
  });

  // Host: start/stop the 3s heartbeat as host status flips.
  $effect(() => {
    const p = player;
    if (!p || !isHost) {
      stopHeartbeat?.();
      stopHeartbeat = undefined;
      return;
    }
    if (stopHeartbeat) return;
    stopHeartbeat = startHeartbeat(
      (pos) => gateway.sendWatchHeartbeat(channelId, pos),
      p
    );
    return () => {
      stopHeartbeat?.();
      stopHeartbeat = undefined;
    };
  });

  onDestroy(() => {
    stopHeartbeat?.();
    if (player) corrector.dispose(player);
    player?.destroy();
  });

  function handleReady(handle: PlayerHandle): void {
    player = handle;
    // Viewer aligns immediately so first paint matches the host.
    if (!isHost) corrector.apply(handle, party);
  }

  function handleEvent(e: PlayerEvent): void {
    if (!isHost) return;
    if (e.type === 'play') gateway.sendWatchControl(channelId, 'play', e.position);
    else if (e.type === 'pause') gateway.sendWatchControl(channelId, 'pause', e.position);
    else if (e.type === 'seek') gateway.sendWatchControl(channelId, 'seek', e.position);
    // ready/error: nothing to broadcast.
  }

  function stop(): void {
    if (!isHost) return;
    gateway.stopWatchParty(channelId);
  }

  const sourceLabel = $derived.by(() => {
    const s = party.source;
    if (s.type === 'youtube') return `YouTube · ${s.embed_id}`;
    if (s.type === 'twitch') return `Twitch · VOD ${s.embed_id}`;
    try {
      return new URL(s.url).hostname;
    } catch {
      return 'Direkt-Video';
    }
  });
</script>

<div
  class="border-border bg-bg-chat relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border"
  data-testid="watch-party-tile"
>
  <header class="flex shrink-0 items-center gap-2 px-3 py-2 text-xs">
    <PlayCircleIcon class="text-primary size-4 shrink-0" />
    <span class="text-text-bright font-medium">Watch Party</span>
    <span class="text-text-muted">·</span>
    <span class="text-text-muted truncate" data-testid="watch-party-source-label">{sourceLabel}</span>
    <span class="text-text-muted ml-auto truncate" data-testid="watch-party-host-label">
      Host: {hostName}
    </span>
    {#if isHost}
      <button
        type="button"
        onclick={stop}
        class="ml-1 rounded-full bg-black/40 px-2 py-0.5 text-white transition-colors hover:bg-black/60"
        aria-label="Watch Party beenden"
        title="Watch Party beenden"
        data-testid="watch-party-stop"
      >
        <XIcon class="size-3" />
      </button>
    {/if}
  </header>

  <div class="relative min-h-0 flex-1 bg-black">
    {#if party.source.type === 'youtube'}
      <YouTubePlayer
        source={party.source}
        controlsEnabled={isHost}
        onReady={handleReady}
        onEvent={handleEvent}
      />
    {:else if party.source.type === 'twitch'}
      <TwitchPlayer
        source={party.source}
        controlsEnabled={isHost}
        onReady={handleReady}
        onEvent={handleEvent}
      />
    {:else}
      <NativeVideoPlayer
        source={party.source}
        controlsEnabled={isHost}
        onReady={handleReady}
        onEvent={handleEvent}
      />
    {/if}
  </div>
</div>
