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
  import RewindIcon from '@lucide/svelte/icons/rewind';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import WatchChatPanel from './WatchChatPanel.svelte';
  import WatchPartyHandoffMenu from './WatchPartyHandoffMenu.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { toast } from 'svelte-sonner';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { userCache } from '$lib/stores/users.svelte';
  import { isPassiveSource, type WatchPartyState } from '$lib/stores/watchPartyPresence.svelte';
  import { watchWatchers } from '$lib/stores/watchWatchers.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
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
  let myId = $derived(currentServerUserId());
  // party_id is invariant for a tile instance (the grid keys tiles by it).
  // $derived (not a plain const) keeps it reactive-clean for the send helpers.
  const partyId = $derived(party.party_id);

  function handleDetach(): void {
    const opened = detachedWatchParties.open(channelId, partyId);
    if (!opened) {
      toast.error(m.watch_party_tile_popup_blocked(), {
        description: m.watch_party_tile_popup_blocked_description()
      });
    }
  }

  const isHost = $derived(!!myId && party.host_user_id === myId);
  const hostName = $derived(userCache.displayName(party.host_user_id));
  // Passive sources (Twitch live) have no seekable position — no central sync.
  const isPassive = $derived(isPassiveSource(party.source));
  // YouTube can be a live stream; the host gets a manual "30s back" escape
  // hatch (in case auto-detection misses) — see PartyController.backToBuffer.
  const isYouTube = $derived(party.source.type === 'youtube');
  const autoplay = $derived(isPassive || party.is_playing);

  const controller = new PartyController(
    () => channelId,
    () => party,
    () => isHost,
    () => isPassive
  );
  function handleReady(handle: PlayerHandle): void {
    controller.onReady(handle);
    // The player handle is a plain field, not reactive — assigning it does NOT
    // re-run the sync $effects below. Crucially syncHeartbeat()'s effect only
    // reads the memoized isHost/isPassive deriveds (which don't change after
    // mount), so it runs ONCE at mount when the player isn't ready yet and
    // never again → the host heartbeat would never start and nothing would
    // propagate. Kick both now that the player exists; the effects still handle
    // later party/role changes.
    controller.syncHeartbeat();
    controller.syncViewer();
  }
  function handleEvent(e: PlayerEvent): void {
    controller.onEvent(e);
  }

  // Keep the monitor awake while video is actively playing — live sources
  // (Twitch live) always while open, seekable sources while the host plays.
  // Releases on pause / hidden tab / unmount (handled in the wake-lock helper
  // + the effect cleanup), so an idle paused tile lets the screen sleep again.
  $effect(() => {
    if (!autoplay) return;
    const release = acquireWakeLock();
    return release;
  });

  // Viewer-Sync: re-runs on every `party` change (syncViewer reads `party`).
  $effect(() => {
    controller.syncViewer();
  });
  // Host-Heartbeat: re-runs when the role (isHost/isPassive) flips — e.g. a
  // handoff stops/starts it. The INITIAL start happens in handleReady (this
  // effect can't, since the player handle isn't reactive and isHost/isPassive
  // don't change after mount).
  $effect(() => {
    controller.syncHeartbeat();
  });

  // Watcher-Registry: mount = join, unmount = leave (covers tile-close +
  // channel-switch unmount + party-end unmount). Zwei Ausnahmen, in denen das
  // Unmount KEIN watch_leave senden darf:
  //  1. Abdocken ins Popup — sonst beendet `end_if_host` die Party, bevor das
  //     Popup (eigene Session, Kaltstart) gejoint hat. Das Popup übernimmt den
  //     Watcher-Eintrag; das Hauptfenster bleibt Anker bis es regulär schliesst.
  //  2. Reine UI-Navigation, während wir noch im Voice-Kanal DIESER Party
  //     hängen: das Tile lebt nur, solange der Voice-Kanal in der UI angesehen
  //     wird, also unmountet es beim Klick auf einen Text-Kanal / eine andere
  //     Community. Die Voice-Verbindung (livekit) besteht weiter — die Party an
  //     ihr UI-Tile zu binden würde den Host beim blossen Weg-Navigieren aus
  //     seiner Party werfen (`end_if_host`). Die Party gehört an die Voice-
  //     Lebensdauer: ein echter Voice-Wechsel/-Leave (`voice.disconnect`) räumt
  //     die Host-Party über `stopWatchParty` ab UND setzt `voiceState` auf
  //     disconnected, bevor das Tile unmountet — dann greift dieser Guard nicht
  //     und das watch_leave läuft wieder normal (für Viewer korrekt).
  onMount(() => {
    gateway.sendWatchJoin(channelId, partyId);
    return () => {
      if (detachedWatchParties.shouldSuppressLeave(channelId, partyId)) return;
      if (inVoiceChannel(channelId)) return;
      gateway.sendWatchLeave(channelId, partyId);
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
    const me = myId;
    if (me && h === me && prevHostId !== undefined && prevHostId !== me) {
      toast.success(m.watch_party_tile_now_controlling());
    }
    prevHostId = h;
  });

  // Current watchers other than me — fed to the handoff picker.
  const otherWatchers = $derived(
    watchWatchers.watchersIn(channelId, partyId).filter((id) => id !== myId)
  );

  // Total watchers (incl. me) for the "X watching" badge.
  const watcherCount = $derived(watchWatchers.watchersIn(channelId, partyId).length);

  // Lazy-fetch the YouTube video title via oEmbed.
  $effect(() => {
    if (party.source.type === 'youtube') prefetchYoutubeTitle(party.source.embed_id);
  });

  function stop(): void {
    if (!isHost) return;
    gateway.stopWatchParty(channelId, partyId);
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
  onHide={() => {
    // Explizites Schließen der Kachel per X: ein Zuschauer verlässt damit die
    // Party aktiv (raus aus der Watcher-Registry), auch wenn er im Voice bleibt
    // — im Gegensatz zu reinem UI-Wegnavigieren, das der inVoiceChannel-Guard im
    // Unmount abfängt. Der Host behält seine Party (Host-sticky); für ihn ist das
    // X nur Verstecken, kein Beenden. Der Unmount-Guard unterdrückt danach das
    // doppelte watch_leave (er ist ja noch im Voice).
    if (!isHost) gateway.sendWatchLeave(channelId, partyId);
    openedTiles.closeParty(channelId, partyId);
  }}
  {compact}
  {focused}
  {onToggleFocus}
>
  {#snippet media()}
    <div class="relative min-h-0 w-full flex-1 bg-black">
      {#if party.source.type === 'youtube'}
        <YouTubePlayer
          source={party.source}
          autoplay={autoplay}
          onReady={handleReady}
          onEvent={handleEvent}
        />
      {:else if party.source.type === 'twitch' || party.source.type === 'twitch_live'}
        <TwitchPlayer
          source={party.source}
          autoplay={autoplay}
          onReady={handleReady}
          onEvent={handleEvent}
        />
      {:else}
        <NativeVideoPlayer
          source={party.source}
          autoplay={autoplay}
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
    {#if watcherCount > 0}
      <span
        class="rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
        data-testid="watch-party-watcher-count"
      >
        {m.watch_party_tile_watching({ count: watcherCount })}
      </span>
    {/if}
  {/snippet}
  {#snippet controlsExtra()}
    {#if isHost}
      {#if isYouTube}
        <button
          type="button"
          onclick={() => controller.backToBuffer()}
          class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-white/20 md:p-1.5"
          aria-label={m.watch_party_tile_rewind30_aria()}
          title={m.watch_party_tile_rewind30_aria()}
          data-testid="watch-party-rewind30"
        >
          <RewindIcon class="size-5 md:size-3.5" />
        </button>
      {/if}
      <WatchPartyHandoffMenu {channelId} {partyId} others={otherWatchers} />
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
    <WatchChatPanel {channelId} {partyId} onClose={() => (chatOpen = false)} />
  {/snippet}
</TileShell>
