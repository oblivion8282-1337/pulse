<!--
  WatchPartyTile — eine aktive Watch-Party in einem Voice-Channel.

  Mountet den passenden Player (YouTube / Twitch / Native) anhand
  `party.source.type`. Beide Seiten kriegen native Player-Controls
  (Lautstärke / Qualität / Fullscreen) — beim Host werden play/pause/seek
  über das WS broadcasted, Viewer-Events werden lokal verarbeitet aber
  nicht broadcasted.

  Sync-Strategie (Viewer):
    * Erste Anwendung nach Player-ready → applyHard (Player ausrichten).
    * Folgende Updates → Heuristik: Wenn is_playing flippt oder die Position
      um mehr als ~2s vom erwarteten Wert abweicht (= Host hat geseekt) →
      applyHard. Sonst → applySoft (nur Drift-Korrektur, kein erzwungenes
      play/pause).
    * Hat der Viewer lokal pausiert (`viewerPaused`) → keine Drift-Korrektur,
      bis er wieder selbst auf Play drückt. So darf jeder kurz wegtreten
      ohne dass der nächste Heartbeat ihn 3s später zurück ins Play kickt.

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
  let stopHeartbeat: (() => void) | undefined;
  const corrector = new DriftCorrector();

  // Tracks the last `party` value we synced against — drives the
  // transition-vs-heartbeat decision in the viewer $effect below. Not $state:
  // it's pure bookkeeping that shouldn't trigger reactivity.
  let prevParty: WatchPartyState | undefined;
  // Viewer-local: did the viewer manually pause? If yes, heartbeat-only
  // updates skip drift correction so they stay paused until they themselves
  // press play (or the host triggers a transition).
  let viewerPaused = false;

  // How far position can drift from the heartbeat-extrapolated value before
  // we treat it as an explicit host seek (vs the natural advancement during
  // playback). 2s comfortably covers heartbeat jitter and small clock skew.
  const SEEK_DETECTION_THRESHOLD_S = 2.0;

  const isHost = $derived(!!auth.user && party.host_user_id === auth.user.id);
  const hostName = $derived(userCache.displayName(party.host_user_id));

  $effect(() => {
    userCache.queue(party.host_user_id);
  });

  // Viewer: align the player to the remote state. Distinguishes a host-
  // driven transition (force play/pause/position) from a heartbeat (only
  // correct position drift, never override the viewer's local pause).
  $effect(() => {
    const p = player;
    if (!p || isHost) return;
    const cur = party;
    const prev = prevParty;
    prevParty = cur;
    if (!prev) {
      // First sync after player ready — fully align.
      viewerPaused = !cur.is_playing;
      corrector.applyHard(p, cur);
      return;
    }
    const playingFlipped = prev.is_playing !== cur.is_playing;
    const expectedFromPrev = expectedPosition(prev, cur.updated_at);
    const positionJumped =
      Math.abs(cur.position - expectedFromPrev) > SEEK_DETECTION_THRESHOLD_S;
    if (playingFlipped || positionJumped) {
      viewerPaused = !cur.is_playing;
      corrector.applyHard(p, cur);
      return;
    }
    // Pure heartbeat. If the viewer paused locally, leave them alone.
    if (!viewerPaused) corrector.applySoft(p, cur);
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
    // The $effect above will run on the next tick with prevParty=undefined
    // and applyHard the initial state — no manual call needed here.
  }

  function handleEvent(e: PlayerEvent): void {
    if (isHost) {
      if (e.type === 'play') gateway.sendWatchControl(channelId, 'play', e.position);
      else if (e.type === 'pause') gateway.sendWatchControl(channelId, 'pause', e.position);
      else if (e.type === 'seek') gateway.sendWatchControl(channelId, 'seek', e.position);
      return;
    }
    // Viewer-side events don't broadcast — but we use them locally so a
    // manual pause sticks (next heartbeat won't undo it) and a manual play
    // re-engages drift correction.
    if (e.type === 'pause') viewerPaused = true;
    else if (e.type === 'play') {
      viewerPaused = false;
      if (player) corrector.applyHard(player, party);
    }
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
      <YouTubePlayer source={party.source} onReady={handleReady} onEvent={handleEvent} />
    {:else if party.source.type === 'twitch'}
      <TwitchPlayer source={party.source} onReady={handleReady} onEvent={handleEvent} />
    {:else}
      <NativeVideoPlayer source={party.source} onReady={handleReady} onEvent={handleEvent} />
    {/if}
  </div>
</div>
