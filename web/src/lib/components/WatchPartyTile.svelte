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
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import WatchChatPanel from './WatchChatPanel.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { toast } from 'svelte-sonner';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { isPassiveSource, type WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
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
    /** Wenn false (Popup-Modus), kein Detach-Button — wir sind ja schon
     *  entkoppelt. */
    canDetach?: boolean;
    /** Filmstrip-Kachel im Fokus-Modus. */
    compact?: boolean;
    /** Diese Kachel ist die fokussierte (große). */
    focused?: boolean;
    onToggleFocus?: () => void;
  }

  let {
    channelId,
    party,
    canDetach = true,
    compact = false,
    focused = false,
    onToggleFocus
  }: Props = $props();

  // Inline-Watch-Chat (Side-Panel rechts im Tile). Header-Toggle.
  let chatOpen = $state(false);

  function handleDetach(): void {
    const opened = detachedWatchParties.open(channelId);
    if (!opened) {
      toast.error('Popup blockiert', {
        description: 'Bitte erlaube Pop-up-Fenster für Pulse und versuche es erneut.'
      });
    }
  }

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
  // echo of our own programmatic seek/play/pause. 2000ms covers slow YT
  // seek round-trips — BUFFERING → PLAYING typically lands within 200-500ms
  // but spikes to 1-1.5s on weak devices / busy networks. The original
  // 750ms (2b8e3b0) caught the median but leaked the spikes, and a leaked
  // PLAYING event re-entered syncHard → seek → another buffer → another
  // late PLAYING … the stutter-back-and-forth viewers see as "looping".
  // 2000ms < heartbeat interval (3000ms) so legitimate manual play/pause
  // outside the post-sync echo window still works.
  const SYNC_QUIET_MS = 2000;
  let syncingUntil = 0;

  function syncHard(p: PlayerHandle, s: WatchPartyState): void {
    const before = p.getCurrentTime();
    const expected = expectedPosition(s);
    const action = corrector.applyHard(p, s);
    if (action !== 'none') {
      syncingUntil = Date.now() + SYNC_QUIET_MS;
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[wp] syncHard', {
        action,
        playerBefore: before.toFixed(2),
        expected: expected.toFixed(2),
        drift: (expected - before).toFixed(2),
        isPlaying: s.is_playing,
        statePos: s.position.toFixed(2),
        quietFor: SYNC_QUIET_MS
      });
    }
  }
  function syncSoft(p: PlayerHandle, s: WatchPartyState): void {
    const before = p.getCurrentTime();
    const expected = expectedPosition(s);
    const action = corrector.applySoft(p, s);
    if (action !== 'none') {
      syncingUntil = Date.now() + SYNC_QUIET_MS;
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[wp] syncSoft', {
        action,
        playerBefore: before.toFixed(2),
        expected: expected.toFixed(2),
        drift: (expected - before).toFixed(2),
        isPlaying: s.is_playing,
        statePos: s.position.toFixed(2)
      });
    }
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
  // Passive sources (Twitch live) have no seekable position — skip
  // heartbeats, drift correction, and play/pause broadcast. The "host" only
  // owns start/stop. All viewers share the embed at their own buffer depth
  // (~1-2s spread on Twitch's Source quality), no central sync possible.
  const isPassive = $derived(isPassiveSource(party.source));

  $effect(() => {
    userCache.queue(party.host_user_id);
  });

  // Viewer: align the player to the remote state. Distinguishes a host-
  // driven transition (force play/pause/position) from a heartbeat (only
  // correct position drift, never override the viewer's local pause).
  // Passive sources (live) don't sync at all — just embed it.
  $effect(() => {
    const p = player;
    if (!p || isHost || isPassive) return;
    const cur = party;
    const prev = prevParty;
    prevParty = cur;
    if (!prev) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log('[wp] viewer effect: INITIAL', {
          statePos: cur.position.toFixed(2),
          isPlaying: cur.is_playing,
          playerTime: p.getCurrentTime().toFixed(2)
        });
      }
      viewerPaused = !cur.is_playing;
      syncHard(p, cur);
      return;
    }
    const playingFlipped = prev.is_playing !== cur.is_playing;
    const expectedFromPrev = expectedPosition(prev, cur.updated_at);
    const positionJumped =
      Math.abs(cur.position - expectedFromPrev) > SEEK_DETECTION_THRESHOLD_S;
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[wp] viewer effect', {
        branch: playingFlipped ? 'transition-play' : positionJumped ? 'transition-seek' : 'heartbeat',
        prevPos: prev.position.toFixed(2),
        curPos: cur.position.toFixed(2),
        expectedFromPrev: expectedFromPrev.toFixed(2),
        positionDelta: (cur.position - expectedFromPrev).toFixed(2),
        prevPlaying: prev.is_playing,
        curPlaying: cur.is_playing,
        viewerPaused,
        deltaMsBetweenStates: cur.updated_at - prev.updated_at
      });
    }
    if (playingFlipped || positionJumped) {
      viewerPaused = !cur.is_playing;
      syncHard(p, cur);
      return;
    }
    if (!viewerPaused) syncSoft(p, cur);
  });

  $effect(() => {
    const p = player;
    if (!p || !isHost || isPassive) {
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
      // Live: host's local play/pause is just local — nothing to broadcast,
      // viewers each manage their own playback against the live edge.
      if (isPassive) return;
      if (e.type === 'play') scheduleBroadcast('play', e.position);
      else if (e.type === 'pause') scheduleBroadcast('pause', e.position);
      else if (e.type === 'seek') scheduleBroadcast('seek', e.position);
      return;
    }
    if (isPassive) return; // viewer side: nothing to suppress / re-sync on live
    // Viewer events don't broadcast. We track them locally so a manual pause
    // sticks (next heartbeat won't undo it) and a manual play re-engages
    // drift correction. Suppress the echo of our own programmatic
    // seek/play/pause — siehe SYNC_QUIET_MS-Block oben.
    const now = Date.now();
    const msToWindowEnd = syncingUntil - now;
    if ((e.type === 'play' || e.type === 'pause') && now < syncingUntil) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log('[wp] handleEvent SUPPRESSED', {
          type: e.type,
          position: e.position?.toFixed?.(2),
          msToWindowEnd
        });
      }
      return;
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[wp] handleEvent', {
        type: e.type,
        position: 'position' in e ? e.position?.toFixed?.(2) : undefined,
        msToWindowEnd,
        viewerPaused
      });
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
    if (s.type === 'twitch_live') return `Twitch · ${s.channel}`;
    try {
      return new URL(s.url).hostname;
    } catch {
      return 'Direkt-Video';
    }
  });
</script>

<TileShell
  kind="party"
  containerTestid="watch-party-tile"
  testidPrefix="watch-party"
  staticHud
  name={sourceLabel}
  nameTestid="watch-party-source-label"
  {chatOpen}
  onToggleChat={() => (chatOpen = !chatOpen)}
  onDetach={canDetach ? handleDetach : undefined}
  onHide={() => openedTiles.closeParty(channelId)}
  {compact}
  {focused}
  {onToggleFocus}
>
  {#snippet media()}
    <div class="relative min-h-0 w-full flex-1 bg-black">
      {#if party.source.type === 'youtube'}
        <YouTubePlayer source={party.source} onReady={handleReady} onEvent={handleEvent} />
      {:else if party.source.type === 'twitch' || party.source.type === 'twitch_live'}
        <TwitchPlayer source={party.source} onReady={handleReady} onEvent={handleEvent} />
      {:else}
        <NativeVideoPlayer source={party.source} onReady={handleReady} onEvent={handleEvent} />
      {/if}
    </div>
  {/snippet}
  {#snippet nameExtra()}
    {#if isPassive}
      <span
        class="rounded-full bg-red-500/30 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-red-200 backdrop-blur-sm"
        title="Live-Stream — kein zentraler Sync, Viewer landen auf ihrer eigenen Buffer-Position"
        data-testid="watch-party-live-badge"
      >
        LIVE
      </span>
    {/if}
    <span
      class="max-w-36 truncate rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
      data-testid="watch-party-host-label"
    >
      Host: {hostName}
    </span>
  {/snippet}
  {#snippet controlsExtra()}
    {#if isHost}
      <button
        type="button"
        onclick={stop}
        class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-red-600 md:p-1.5"
        aria-label="Watch Party beenden"
        title="Watch Party beenden"
        data-testid="watch-party-stop"
      >
        <XIcon class="size-5 md:size-3.5" />
      </button>
    {/if}
  {/snippet}
  {#snippet chatPanel()}
    <WatchChatPanel {channelId} onClose={() => (chatOpen = false)} />
  {/snippet}
</TileShell>
