<!--
  WatchPartyTile — eine aktive Watch-Party in einem Voice-Channel.

  YouTube-Zuschauer bekommen einen read-only Player (`interactive=false` →
  controls:0), damit NUR der Host die Wiedergabe steuert. Was dabei an nativer
  Chrome wegfällt und persönlich (nicht Party-weit) ist, gibt die Kachel übers
  TileShell-HUD zurück: Lautstärke und Untertitel-Auswahl. Ein Klick-Fänger über
  dem iframe schluckt Video-Klicks (YouTube pausiert sonst auch ohne Chrome).
  Der Host behält die volle native Steuerung. Twitch/Native folgen später.

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
  import ReplaceIcon from '@lucide/svelte/icons/replace';
  import PictureInPicture2Icon from '@lucide/svelte/icons/picture-in-picture-2';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import WatchChatPanel from './WatchChatPanel.svelte';
  import WatchQueuePanel from './WatchQueuePanel.svelte';
  import WatchCaptionsMenu from './WatchCaptionsMenu.svelte';
  import WatchPartyHandoffMenu from './WatchPartyHandoffMenu.svelte';
  import WatchSourceDialog from './WatchSourceDialog.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { watchBackground } from '$lib/watch/watchBackground.svelte';
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
  import { CaptionsState } from '$lib/watch/captionsState.svelte';
  import { PartyController } from '$lib/watch/partyController.svelte';
  import type { PlayerEvent, PlayerHandle } from '$lib/watch/sync';

  interface Props {
    channelId: string;
    party: WatchPartyState;
    /** Wenn false (Popup-Modus), kein Detach-Button — wir sind ja schon
     *  entkoppelt. */
    canDetach?: boolean;
    /** Wenn false (Popup-Modus), kein Ausblenden-X: im eigenen Fenster wäre
     *  „Ausblenden" der einzige Inhalt, und als Host würde ein watch_leave die
     *  Party ohnehin sofort beenden (`end_if_host`). Schließen läuft dort über
     *  „Andocken" / Fenster-X, Beenden über „Watchparty beenden". */
    canHide?: boolean;
    /** Nur im Popup gesetzt: legt den „Andocken"-Knopf in die Steuerleiste
     *  (statt als Overlay oben rechts), der das Popup schließt und die Kachel
     *  wieder inline andockt. */
    onDock?: () => void;
  }

  let { channelId, party, canDetach = true, canHide = true, onDock }: Props = $props();

  // Rechtes Seitenpanel: Chat ODER Warteschlange, nie beide gleichzeitig
  // (teilen sich den Slot). Die beiden Toggles schliessen sich gegenseitig.
  let chatOpen = $state(false);
  let queueOpen = $state(false);
  function toggleChat(): void {
    chatOpen = !chatOpen;
    if (chatOpen) queueOpen = false;
  }
  function toggleQueue(): void {
    queueOpen = !queueOpen;
    if (queueOpen) chatOpen = false;
  }
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

  // Explizites Schließen der Kachel per X: ein Zuschauer verlässt damit die
  // Party aktiv (raus aus der Watcher-Registry), auch wenn er im Voice bleibt
  // — im Gegensatz zu reinem UI-Wegnavigieren, das der inVoiceChannel-Guard im
  // Unmount abfängt. Der Host behält seine Party (Host-sticky); für ihn ist das
  // X nur Verstecken, kein Beenden. Der Unmount-Guard unterdrückt danach das
  // doppelte watch_leave (er ist ja noch im Voice).
  function hideTile(): void {
    if (!isHost) gateway.sendWatchLeave(channelId, partyId);
    watchBackground.closeParty(channelId, partyId);
  }

  const isHost = $derived(!!myId && party.host_user_id === myId);
  const hostName = $derived(userCache.displayName(party.host_user_id));
  // Passive sources (Twitch live) have no seekable position — no central sync.
  const isPassive = $derived(isPassiveSource(party.source));
  // YouTube can be a live stream; the host gets a manual "30s back" escape
  // hatch (in case auto-detection misses) — see PartyController.backToBuffer.
  const isYouTube = $derived(party.source.type === 'youtube');
  const autoplay = $derived(isPassive || party.is_playing);

  // Zuschauer eines YouTube-Videos bekommen einen read-only Player (Punkt 2):
  // keine native Wiedergabe-Steuerung, nur Zusehen. Fokus YouTube — Twitch und
  // Native folgen demselben Muster später.
  const viewerReadonly = $derived(!isHost && isYouTube);

  const controller = new PartyController(
    () => channelId,
    () => party,
    () => isHost,
    () => isPassive
  );

  // Eigenes Lautstärke-Control für den read-only Zuschauer-Player: der native
  // YT-Regler fehlt bei controls:0, also reicht die Kachel die Lautstärke über
  // den Controller an den Player durch (0–100). Der Host nutzt weiter den
  // nativen Regler seiner vollen Chrome.
  let viewerVolume = $state(100);
  let volBeforeMute = 100;
  // Slider-Anzeige und Player immer im Gleichschritt setzen.
  function setViewerVolume(percent: number): void {
    viewerVolume = percent;
    controller.setVolume(percent);
  }
  function onViewerVolume(e: Event): void {
    setViewerVolume(Number((e.currentTarget as HTMLInputElement).value));
  }
  function onViewerMute(): void {
    if (viewerVolume > 0) {
      volBeforeMute = viewerVolume;
      setViewerVolume(0);
    } else {
      setViewerVolume(volBeforeMute || 100);
    }
  }
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
  // Untertitel des Zuschauer-Players: derselbe Weg wie die Lautstärke oben —
  // `controls:0` nimmt ihm den CC-Knopf, die Kachel gibt ihn zurück. Rein
  // lokal, nicht synchronisiert. Details in CaptionsState.
  const captions = new CaptionsState(controller);

  function handleEvent(e: PlayerEvent): void {
    // YouTube meldet seine Untertitel-Spuren erst nach dem Wiedergabestart
    // (onApiChange) — das Control taucht also kurz nach dem Video auf.
    if (e.type === 'captions_changed') {
      captions.refresh();
      return;
    }
    // Netz gegen ein verpasstes captions_changed: onApiChange feuert nur EINMAL,
    // kurz nach dem Player-Start. War der Player-Handle in dem Moment noch nicht
    // im Controller (Reihenfolge onReady/onApiChange ist nicht garantiert), las
    // refresh() eine leere Spurliste — und ein zweites Event kommt nie. Beim
    // Wiedergabestart deshalb nachsehen, solange wir keine Spuren haben.
    if (e.type === 'play' && captions.tracks.length === 0) captions.refresh();
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

  // "Video wechseln": Host tauscht die Quelle ohne die Party neu zu starten —
  // party_id, Watcher, Chat und Handoff-State bleiben. Der Backend-Push
  // (watch_state) trägt die neue source an alle.
  let changeOpen = $state(false);
  function changeSource(url: string): boolean {
    return gateway.changeWatchSource(channelId, partyId, url);
  }

  // Identität der Quelle — treibt sowohl das Player-Remount ({#key} unten) als
  // auch den Viewer-Toast. Die Player lesen ihre embed_id/url nur einmalig beim
  // Mount (asynchron, daher nicht reaktiv getrackt), also muss ein
  // Quellenwechsel den Player komplett neu mounten, statt nur die Prop zu
  // aktualisieren — sonst bleibt das alte Video stehen.
  const sourceKey = $derived(JSON.stringify(party.source));

  // Der Player liest `interactive`/`controls` nur beim Mount → ein Handoff
  // (isHost flippt) muss den Player komplett neu mounten, damit ein neuer Host
  // die native Steuerung bekommt bzw. ein degradierter Ex-Host sie verliert.
  // sourceKey deckt den Quellenwechsel ab, isHost den Rollenwechsel.
  const playerKey = $derived(sourceKey + ':' + isHost);

  // Viewer-Hinweis, wenn der Host live das Video wechselt — sonst wirkt der
  // kurze Player-Reload wie ein Bug. Nicht für den Host selbst, nicht beim
  // ersten Mount.
  let prevSourceKey: string | undefined;
  $effect(() => {
    const changed = prevSourceKey !== undefined && prevSourceKey !== sourceKey;
    if (changed && !isHost) {
      toast.info(m.watch_party_tile_source_changed());
    }
    if (changed) {
      // Kill the host heartbeat the moment the source changes — the player is
      // about to remount ({#key} below), and a beat from the old (soon-destroyed)
      // player must not land with the already-bumped epoch. Rebinds on the new
      // player's handleReady. No-op for viewers.
      controller.suspendHeartbeat();
      // Die Spuren des alten Videos gelten nicht mehr; der neue Player meldet
      // seine eigenen per captions_changed. Die Sprachwahl des Zuschauers
      // überlebt das (siehe CaptionsState).
      captions.reset();
    }
    prevSourceKey = sourceKey;
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
      return m.watch_party_tile_direct_video();
    }
  });
</script>

<TileShell
  kind="party"
  containerTestid="watch-party-tile"
  testidPrefix="watch-party"
  name={sourceLabel}
  nameTestid="watch-party-source-label"
  volume={viewerReadonly ? viewerVolume : undefined}
  onVolumeChange={viewerReadonly ? onViewerVolume : undefined}
  onToggleMute={viewerReadonly ? onViewerMute : undefined}
  {chatOpen}
  onToggleChat={toggleChat}
  {queueOpen}
  onToggleQueue={toggleQueue}
  onDetach={canDetach ? handleDetach : undefined}
  onHide={canHide ? hideTile : undefined}
>
  {#snippet media()}
    <div class="relative min-h-0 w-full flex-1 bg-black">
      <!-- Remount bei Quellen- ODER Rollenwechsel: die Player lesen Quelle und
           `interactive` nur beim Mount (siehe playerKey oben). -->
      {#key playerKey}
        {#if party.source.type === 'youtube'}
          <YouTubePlayer
            source={party.source}
            autoplay={autoplay}
            interactive={isHost}
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
      {/key}
      {#if viewerReadonly}
        <!-- Klick-Fänger: YouTube pausiert auch ohne sichtbare Steuerung bei
             einem Klick aufs Video. Dieses Overlay schluckt solche Klicks, damit
             nur der Host die Wiedergabe steuert. Vollbild bleibt über den Knopf
             in der Leiste erreichbar. -->
        <div
          class="absolute inset-0 z-10"
          data-testid="watch-party-viewer-lock"
          aria-hidden="true"
        ></div>
      {/if}
    </div>
  {/snippet}
  {#snippet nameExtra()}
    {#if isPassive}
      <span
        class="rounded-full bg-red-500/30 px-2 py-1 text-2xs font-semibold tracking-wider text-red-200 uppercase backdrop-blur-sm"
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
    {#if onDock}
      <button
        type="button"
        onclick={onDock}
        class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-white/20 md:p-1.5"
        aria-label={m.watch_popup_reattach_label()}
        title={m.watch_popup_reattach_title()}
        data-testid="watch-party-dock"
      >
        <PictureInPicture2Icon class="size-5 md:size-3.5" />
      </button>
    {/if}
    {#if viewerReadonly && captions.tracks.length > 0}
      <WatchCaptionsMenu
        tracks={captions.tracks}
        active={captions.active}
        onSelect={(lang) => captions.select(lang)}
      />
    {/if}
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
      <button
        type="button"
        onclick={() => (changeOpen = true)}
        class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-white/20 md:p-1.5"
        aria-label={m.watch_party_tile_change_source_aria()}
        title={m.watch_party_tile_change_source_aria()}
        data-testid="watch-party-change-source"
      >
        <ReplaceIcon class="size-5 md:size-3.5" />
      </button>
      <WatchPartyHandoffMenu {channelId} {partyId} others={otherWatchers} />
      <button
        type="button"
        onclick={stop}
        class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-destructive md:p-1.5"
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
  {#snippet queuePanel()}
    <WatchQueuePanel {channelId} {partyId} {party} onClose={() => (queueOpen = false)} />
  {/snippet}
</TileShell>

{#if isHost}
  <WatchSourceDialog
    bind:open={changeOpen}
    title={m.watch_party_change_dialog_title()}
    confirmLabel={m.watch_party_change_confirm()}
    onConfirm={changeSource}
  />
{/if}
