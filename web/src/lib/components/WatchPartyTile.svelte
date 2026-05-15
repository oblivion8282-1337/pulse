<!--
  WatchPartyTile — eine aktive Watch-Party in einem Voice-Channel.

  Mountet den passenden Player (YouTube / Twitch / Native). Host kriegt die
  native Player-Chrome (play/pause/seek/volume/quality/fullscreen) und
  steuert die Party; Viewer haben den Player auf `pointer-events: none` und
  kriegen statt der Native-Chrome eine custom Toolbar im Tile-Header mit
  Lautstärke + Fullscreen — kein play/pause/seek, sonst würden sie sich aus
  der Party kicken.

  Host-Broadcasts (play/pause/seek) sind 300ms trailing-debounced. YouTube
  feuert während Ad-Breaks und Buffer-Phasen mehrere Pause/Play-Events
  hintereinander; ohne Debounce würden Viewer dabei rapide hin- und
  herspringen (das war der „Endlosschleife"-Bug).

  Sync-Strategie (Viewer):
    * Erste Anwendung nach Player-ready → applyHard.
    * is_playing flippt oder Position weicht > 2s vom heartbeat-
      extrapolierten Wert ab (= Host hat geseekt/Play-Pause) → applyHard.
    * Sonst (reiner Heartbeat) → applySoft (nur Drift-Korrektur, kein
      erzwungenes play/pause).
-->
<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import XIcon from '@lucide/svelte/icons/x';
  import PlayCircleIcon from '@lucide/svelte/icons/play-circle';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import type { WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
  import { gateway } from '$lib/ws/connection';
  import NativeVideoPlayer from '$lib/watch/players/NativeVideoPlayer.svelte';
  import TwitchPlayer from '$lib/watch/players/TwitchPlayer.svelte';
  import YouTubePlayer from '$lib/watch/players/YouTubePlayer.svelte';
  import {
    DriftCorrector,
    expectedPosition,
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
  let playerSurface = $state<HTMLDivElement | undefined>();
  let stopHeartbeat: (() => void) | undefined;
  const corrector = new DriftCorrector();

  // Viewer's local volume (0-100). Pushed to the player handle whenever it
  // changes. Persists across heartbeats but resets when the tile remounts
  // (i.e. between parties).
  let volume = $state(100);

  // Tracks the last `party` value we synced against — drives the
  // transition-vs-heartbeat decision in the viewer $effect below.
  let prevParty: WatchPartyState | undefined;

  // How far position can drift from the heartbeat-extrapolated value before
  // we treat it as an explicit host seek (vs the natural advancement during
  // playback). 2s comfortably covers heartbeat jitter and small clock skew.
  const SEEK_DETECTION_THRESHOLD_S = 2.0;

  // Trailing-debounce window for host control broadcasts. YouTube fires
  // multiple PLAYING/PAUSED events in rapid succession during ad breaks and
  // buffer recovery; we only want the final state of any such burst to
  // reach viewers, otherwise their player flickers between play and pause.
  const BROADCAST_DEBOUNCE_MS = 300;
  let pendingBroadcast:
    | { action: 'play' | 'pause' | 'seek'; position: number }
    | undefined;
  let broadcastTimer: number | undefined;

  const isHost = $derived(!!auth.user && party.host_user_id === auth.user.id);
  const hostName = $derived(userCache.displayName(party.host_user_id));

  $effect(() => {
    userCache.queue(party.host_user_id);
  });

  // Viewer: align the player to the remote state. Distinguishes a host-
  // driven transition (force play/pause/position) from a heartbeat (only
  // correct position drift).
  $effect(() => {
    const p = player;
    if (!p || isHost) return;
    const cur = party;
    const prev = prevParty;
    prevParty = cur;
    if (!prev) {
      corrector.applyHard(p, cur);
      return;
    }
    const playingFlipped = prev.is_playing !== cur.is_playing;
    const expectedFromPrev = expectedPosition(prev, cur.updated_at);
    const positionJumped =
      Math.abs(cur.position - expectedFromPrev) > SEEK_DETECTION_THRESHOLD_S;
    if (playingFlipped || positionJumped) {
      corrector.applyHard(p, cur);
      return;
    }
    corrector.applySoft(p, cur);
  });

  // Host: 3s heartbeat as host status flips on.
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

  // Viewer: push local volume to the player whenever the slider changes (or
  // when the handle becomes available after mount).
  $effect(() => {
    if (player && !isHost) player.setVolume(volume);
  });

  onDestroy(() => {
    stopHeartbeat?.();
    if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
    if (player) corrector.dispose(player);
    player?.destroy();
  });

  function handleReady(handle: PlayerHandle): void {
    player = handle;
    // Apply the viewer's chosen volume on mount.
    if (!isHost) handle.setVolume(volume);
  }

  function handleEvent(e: PlayerEvent): void {
    if (!isHost) return; // viewers don't broadcast and can't pause/seek anyway
    if (e.type === 'play') scheduleBroadcast('play', e.position);
    else if (e.type === 'pause') scheduleBroadcast('pause', e.position);
    else if (e.type === 'seek') scheduleBroadcast('seek', e.position);
  }

  function scheduleBroadcast(
    action: 'play' | 'pause' | 'seek',
    position: number
  ): void {
    pendingBroadcast = { action, position };
    if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
    broadcastTimer = window.setTimeout(() => {
      if (pendingBroadcast) {
        gateway.sendWatchControl(
          channelId,
          pendingBroadcast.action,
          pendingBroadcast.position
        );
        pendingBroadcast = undefined;
      }
      broadcastTimer = undefined;
    }, BROADCAST_DEBOUNCE_MS);
  }

  function stop(): void {
    if (!isHost) return;
    gateway.stopWatchParty(channelId);
  }

  async function goFullscreen(): Promise<void> {
    await tick();
    const el = playerSurface;
    if (!el) return;
    try {
      await el.requestFullscreen();
    } catch {
      // user gesture missing / not supported — silent
    }
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
    <span class="text-text-muted truncate" data-testid="watch-party-source-label">
      {sourceLabel}
    </span>
    <span class="text-text-muted ml-auto truncate" data-testid="watch-party-host-label">
      Host: {hostName}
    </span>
    {#if !isHost}
      <!-- viewer-only volume + fullscreen overlay; the player surface
           itself is non-interactive so no native chrome to fight with -->
      <label class="flex items-center gap-1" title="Lautstärke">
        <Volume2Icon class="text-text-muted size-3.5 shrink-0" />
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          bind:value={volume}
          class="h-1 w-16 cursor-pointer accent-primary"
          aria-label="Lautstärke"
          data-testid="watch-party-volume"
        />
      </label>
      <button
        type="button"
        onclick={goFullscreen}
        class="rounded-full bg-black/40 p-1 text-white transition-colors hover:bg-black/60"
        aria-label="Vollbild"
        title="Vollbild"
        data-testid="watch-party-fullscreen"
      >
        <Maximize2Icon class="size-3" />
      </button>
    {:else}
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

  <div bind:this={playerSurface} class="relative min-h-0 flex-1 bg-black">
    {#if party.source.type === 'youtube'}
      <YouTubePlayer
        source={party.source}
        interactive={isHost}
        onReady={handleReady}
        onEvent={handleEvent}
      />
    {:else if party.source.type === 'twitch'}
      <TwitchPlayer
        source={party.source}
        interactive={isHost}
        onReady={handleReady}
        onEvent={handleEvent}
      />
    {:else}
      <NativeVideoPlayer
        source={party.source}
        interactive={isHost}
        onReady={handleReady}
        onEvent={handleEvent}
      />
    {/if}
  </div>
</div>
