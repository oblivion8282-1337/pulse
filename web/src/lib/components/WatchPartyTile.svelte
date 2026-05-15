<!--
  WatchPartyTile — eine aktive Watch-Party in einem Voice-Channel.

  Native Player-Chrome ist für alle aktiv — sonst gibt's keinen Lautstärke-
  Slider / Qualitäts-Picker / Fullscreen-Button (wir können in einem
  iframe-Player nicht selektiv nur play/pause ausblenden). Trade-off:
  Viewer kann lokal pausieren/seeken; das broadcasted aber nichts, und
  Heartbeats lassen ihn in Ruhe solange er pausiert ist. Drückt er wieder
  Play, snappt's auf die aktuelle Host-Position.

  Host-Broadcasts (play/pause/seek) sind 300ms trailing-debounced. YouTube
  feuert während Ad-Breaks / Buffer-Phasen mehrere PLAYING/PAUSED-Events
  hintereinander; ohne Debounce würden Viewer dabei rapide hin- und
  herspringen (das war der „Endlosschleife"-Bug).

  Sync-Strategie (Viewer):
    * Erste Anwendung nach Player-ready → applyHard.
    * is_playing flippt oder Position weicht > 2s vom heartbeat-
      extrapolierten Wert ab (= Host hat geseekt/Play-Pause) → applyHard.
    * Sonst (reiner Heartbeat) → applySoft (nur Drift, kein play/pause).
    * Viewer hat lokal pausiert → keine Drift-Korrektur, bis er wieder
      selbst auf Play drückt.

  Programmatic-Sync-Guard:
    YT.seekTo() und Twitch.seek() triggern intern wieder PLAYING-State-
    Changes → unser `play`-Event-Handler würde applyHard rekursiv aufrufen,
    der seekt erneut, der Player feuert wieder PLAYING, … = sub-Sekunden-
    Endlosschleife im Viewer. `syncingUntil` blendet play/pause-Events
    aus, die innerhalb von SYNC_QUIET_MS nach einer eigenen Sync-Operation
    eintreffen. Manuelles Pausieren/Play durch den User (außerhalb des
    Fensters) bleibt voll funktional.
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
  import { prefetchYoutubeTitle, youtubeTitle } from '$lib/watch/youtubeMeta.svelte';
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

  // Last `party` value we synced against — drives the transition-vs-heartbeat
  // decision in the viewer $effect. Plain `let`, not $state, so updating it
  // inside the effect doesn't re-trigger it.
  let prevParty: WatchPartyState | undefined;
  // Did the viewer manually pause? Set on player 'pause' events, cleared on
  // player 'play' events. Heartbeats skip drift correction while true so
  // someone who paused to grab a drink isn't dragged back to playing 3s later.
  let viewerPaused = false;

  // Position diff vs heartbeat-extrapolated value above which we treat the
  // update as a host seek (and applyHard) instead of a heartbeat.
  const SEEK_DETECTION_THRESHOLD_S = 2.0;

  // Window during which player-emitted play/pause events are ignored as the
  // echo of our own programmatic seek/play/pause. 750ms covers a slow YT
  // seek round-trip (BUFFERING → PLAYING typically lands within 200-500ms).
  const SYNC_QUIET_MS = 750;
  let syncingUntil = 0;

  function syncHard(p: PlayerHandle, s: WatchPartyState): void {
    syncingUntil = Date.now() + SYNC_QUIET_MS;
    corrector.applyHard(p, s);
  }
  function syncSoft(p: PlayerHandle, s: WatchPartyState): void {
    syncingUntil = Date.now() + SYNC_QUIET_MS;
    corrector.applySoft(p, s);
  }

  // Trailing-debounce window for host control broadcasts. YouTube fires
  // multiple PLAYING/PAUSED events in rapid succession during ad breaks and
  // buffer recovery — without this, viewers would ping-pong between play
  // and pause every time the host hit a buffer.
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
  // correct position drift, never override the viewer's local pause).
  $effect(() => {
    const p = player;
    if (!p || isHost) return;
    const cur = party;
    const prev = prevParty;
    prevParty = cur;
    if (!prev) {
      viewerPaused = !cur.is_playing;
      syncHard(p, cur);
      return;
    }
    const playingFlipped = prev.is_playing !== cur.is_playing;
    const expectedFromPrev = expectedPosition(prev, cur.updated_at);
    const positionJumped =
      Math.abs(cur.position - expectedFromPrev) > SEEK_DETECTION_THRESHOLD_S;
    if (playingFlipped || positionJumped) {
      viewerPaused = !cur.is_playing;
      syncHard(p, cur);
      return;
    }
    if (!viewerPaused) syncSoft(p, cur);
  });

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
    if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
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
      if (e.type === 'play') scheduleBroadcast('play', e.position);
      else if (e.type === 'pause') scheduleBroadcast('pause', e.position);
      else if (e.type === 'seek') scheduleBroadcast('seek', e.position);
      return;
    }
    // Viewer events don't broadcast. We track them locally so a manual pause
    // sticks (next heartbeat won't undo it) and a manual play re-engages
    // drift correction. Suppress the echo of our own programmatic
    // seek/play/pause — siehe SYNC_QUIET_MS-Block oben.
    if ((e.type === 'play' || e.type === 'pause') && Date.now() < syncingUntil) {
      return;
    }
    if (e.type === 'pause') viewerPaused = true;
    else if (e.type === 'play') {
      viewerPaused = false;
      if (player) syncHard(player, party);
    }
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

  // Lazy-fetch the YouTube video title via oEmbed; the cache pushes the
  // resolved title back into the reactive label once it lands.
  $effect(() => {
    if (party.source.type === 'youtube') prefetchYoutubeTitle(party.source.embed_id);
  });

  const sourceLabel = $derived.by(() => {
    const s = party.source;
    if (s.type === 'youtube') {
      const title = youtubeTitle(s.embed_id);
      return title ? `YouTube · ${title}` : `YouTube · ${s.embed_id}`;
    }
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
