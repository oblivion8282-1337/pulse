<!--
  WatchPartyTile — eine aktive Watch-Party in einem Voice-Channel.

  Native Player-Chrome ist für alle aktiv — sonst gibt's keinen Lautstärke-
  Slider / Qualitäts-Picker / Fullscreen-Button (wir können in einem
  iframe-Player nicht selektiv nur play/pause ausblenden). Trade-off:
  Viewer kann lokal pausieren/seeken; das broadcasted aber nichts.

  Die gesamte Host/Viewer-Sync-Orchestrierung (Drift-Korrektur, Heartbeat,
  Broadcast-Debounce, Programmatic-Sync-Guard) lebt im PartyController
  (`lib/watch/partyController.svelte.ts`) — dieses Component ist nur die
  Hülle + Player-Auswahl + Host-Controls.

  Watcher-Lifecycle: Mount → watch_join, Unmount → watch_leave. Damit weiß
  der Server, wer die Kachel offen hat → Host-Handoff promotet beim Wegfall
  des Hosts den ältesten verbliebenen Watcher.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import XIcon from '@lucide/svelte/icons/x';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import WatchChatPanel from './WatchChatPanel.svelte';
  import WatchPartyHandoffMenu from './WatchPartyHandoffMenu.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { toast } from 'svelte-sonner';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { isPassiveSource, type WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
  import { watchWatchers } from '$lib/stores/watchWatchers.svelte';
  import { gateway } from '$lib/ws/connection';
  import { acquireWakeLock } from '$lib/platform/wakeLock';
  import NativeVideoPlayer from '$lib/watch/players/NativeVideoPlayer.svelte';
  import TwitchPlayer from '$lib/watch/players/TwitchPlayer.svelte';
  import YouTubePlayer from '$lib/watch/players/YouTubePlayer.svelte';
  import { prefetchYoutubeTitle, youtubeTitle } from '$lib/watch/youtubeMeta.svelte';
  import { PartyController } from '$lib/watch/partyController.svelte';
  import type { PlayerEvent, PlayerHandle } from '$lib/watch/sync';

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
      toast.error(m.watch_party_tile_popup_blocked(), {
        description: m.watch_party_tile_popup_blocked_description()
      });
    }
  }

  const isHost = $derived(!!auth.user && party.host_user_id === auth.user.id);
  const hostName = $derived(userCache.displayName(party.host_user_id));
  // Passive sources (Twitch live) have no seekable position — no central sync.
  const isPassive = $derived(isPassiveSource(party.source));

  const controller = new PartyController(
    () => channelId,
    () => party,
    () => isHost,
    () => isPassive
  );
  function handleReady(handle: PlayerHandle): void {
    controller.onReady(handle);
  }
  function handleEvent(e: PlayerEvent): void {
    controller.onEvent(e);
  }

  // Keep the monitor awake while video is actively playing — live sources
  // (Twitch live) always while open, seekable sources while the host plays.
  // Releases on pause / hidden tab / unmount (handled in the wake-lock helper
  // + the effect cleanup), so an idle paused tile lets the screen sleep again.
  $effect(() => {
    if (!(isPassive || party.is_playing)) return;
    const release = acquireWakeLock();
    return release;
  });

  // Viewer-Sync + Host-Heartbeat: re-run on every `party` change.
  $effect(() => {
    controller.syncViewer();
  });
  $effect(() => {
    controller.syncHeartbeat();
  });

  // Watcher-Registry: mount = join, unmount = leave (covers tile-close +
  // channel-switch unmount + party-end unmount). Ausnahme: ein Unmount, der nur
  // durchs Abdocken ins Popup ausgelöst wird, darf KEIN watch_leave senden —
  // sonst beendet `end_if_host` die Party, bevor das Popup (eigene Session,
  // Kaltstart) gejoint hat. Das Popup übernimmt den Watcher-Eintrag; das
  // Hauptfenster bleibt der Anker, bis es regulär schließt/disconnected.
  onMount(() => {
    gateway.sendWatchJoin(channelId);
    return () => {
      if (detachedWatchParties.shouldSuppressLeave(channelId)) return;
      gateway.sendWatchLeave(channelId);
    };
  });

  onDestroy(() => controller.dispose());

  $effect(() => {
    userCache.queue(party.host_user_id);
  });

  // New-host toast: fires when control transfers TO me (not on start-as-host).
  let prevHostId: string | undefined;
  $effect(() => {
    const h = party.host_user_id;
    const me = auth.user?.id;
    if (me && h === me && prevHostId !== undefined && prevHostId !== me) {
      toast.success(m.watch_party_tile_now_controlling());
    }
    prevHostId = h;
  });

  // Current watchers other than me — fed to the handoff picker.
  const otherWatchers = $derived(
    watchWatchers.watchersIn(channelId).filter((id) => id !== auth.user?.id)
  );

  // Lazy-fetch the YouTube video title via oEmbed.
  $effect(() => {
    if (party.source.type === 'youtube') prefetchYoutubeTitle(party.source.embed_id);
  });

  function stop(): void {
    if (!isHost) return;
    gateway.stopWatchParty(channelId);
  }

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
      return m.watch_party_tile_direct_video();
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
        <YouTubePlayer
          source={party.source}
          autoplay={isPassive || party.is_playing}
          onReady={handleReady}
          onEvent={handleEvent}
        />
      {:else if party.source.type === 'twitch' || party.source.type === 'twitch_live'}
        <TwitchPlayer
          source={party.source}
          autoplay={isPassive || party.is_playing}
          onReady={handleReady}
          onEvent={handleEvent}
        />
      {:else}
        <NativeVideoPlayer
          source={party.source}
          autoplay={isPassive || party.is_playing}
          onReady={handleReady}
          onEvent={handleEvent}
        />
      {/if}
    </div>
  {/snippet}
  {#snippet nameExtra()}
    {#if isPassive}
      <span
        class="rounded-full bg-red-500/30 px-2 py-1 text-[10px] font-semibold tracking-wider text-red-200 uppercase backdrop-blur-sm"
        title={m.watch_party_tile_live_badge_title()}
        data-testid="watch-party-live-badge"
      >
        LIVE
      </span>
    {/if}
    <span
      class="max-w-36 truncate rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
      data-testid="watch-party-host-label"
    >
      {m.watch_party_tile_host_label({ name: hostName })}
    </span>
  {/snippet}
  {#snippet controlsExtra()}
    {#if isHost}
      <WatchPartyHandoffMenu {channelId} others={otherWatchers} />
      <button
        type="button"
        onclick={stop}
        class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-red-600 md:p-1.5"
        aria-label={m.watch_party_tile_stop_aria()}
        title={m.watch_party_tile_stop_aria()}
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
