<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import StreamGrid from './StreamGrid.svelte';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import MemberList from './MemberList.svelte';
  import ChannelHeading from './ChannelHeading.svelte';
  import { gateway } from '$lib/ws/connection';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import UsersIcon from '@lucide/svelte/icons/users';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import { goto } from '$app/navigation';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { hqTileId } from '$lib/stream/hqTile';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { watchBackground } from '$lib/watch/watchBackground.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { shortcut, type ShortcutEventDetail } from '@svelte-put/shortcut';
  import { untrack } from 'svelte';
  import type { Channel } from '$lib/api/types';
  import FieldError from './feedback/FieldError.svelte';

  let { channel }: { channel: Channel } = $props();

  // HQ stream presence for this channel — needed by the prune effect below
  // so that a publisher who stopped doesn't keep auto-mounting a tile.
  let hqStreamers = $derived(streamPresence.streamersIn(channel.id));
  // The per-(user, slot) tile ids currently live — the open HQ tiles are keyed
  // by `<userId>:<slot>`, so the prune/auto-open logic must compare against
  // these composite ids, NOT the bare user ids (a user can have two streams).
  let hqTiles = $derived(
    streamPresence.streamsIn(channel.id).map((s) => hqTileId(s.user_id, s.slot))
  );
  let screenSharerIds = $derived(voicePresence.streamingIn(channel.id));
  let livePartyIds = $derived(watchPartyPresence.partiesIn(channel.id).map((p) => p.party_id));

  // Grid is visible iff the viewer has opened at least one tile (any kind) OR
  // has an open watch party in this channel. The watch party tracks its own
  // open-set (`watchBackground`, voice-tied) rather than `openedTiles`, so it
  // must be checked here too — otherwise starting only a party leaves the grid
  // unmounted, no docked anchor is registered, and the persistent player falls
  // back to the small corner window instead of filling the view.
  // Default-empty after channel switch — see resetChannel below.
  let hasOpenParty = $derived(
    livePartyIds.some((pid) => watchBackground.isOpenParty(channel.id, pid))
  );
  let streamViewOpen = $derived(openedTiles.hasAny(channel.id) || hasOpenParty);

  // Channel betreten: nur bei einem ECHTEN Channel-Wechsel werden die Opens des
  // alten Channels verworfen (dessen HQ-Streams enden dann). Rückkehr in
  // DENSELBEN Channel (z.B. aus einer DM) lässt die Opens stehen → der im
  // Hintergrund weiterlaufende Stream ist sofort wieder da, kein Reconnect.
  $effect(() => {
    const cid = channel.id;
    untrack(() => openedTiles.enterChannel(cid));
  });

  // Prune opens whose publisher stopped — a pause+restart should force a new
  // click. We include the local user's own HQ (so closing his own tile is also
  // sticky) but exclude self from the auto-prune-pruning logic since the user
  // can't accidentally open their own stream.
  $effect(() => {
    const cid = channel.id;
    const hqSet = new Set(hqTiles);
    const screenIdentities = new Set(voice.screenTracks.map((s) => s.identity));
    const camIdentities = new Set(voice.cameraTracks.map((c) => c.identity));
    const partySet = new Set(livePartyIds);
    untrack(() =>
      openedTiles.pruneChannel(cid, {
        hq: hqSet,
        screen: screenIdentities,
        cam: camIdentities,
        party: partySet
      })
    );
  });

  // Wenn ein Streamer, den der Viewer bereits anschaut, einen WEITEREN Stream
  // (zweiter Monitor = neuer Slot) startet, die neue Kachel automatisch daneben
  // öffnen — statt dass der User raten muss, dass es einen zweiten gibt. Greift
  // nur, wenn schon eine andere Kachel desselben Streamers offen ist (sonst
  // bleibt es beim klick-zum-öffnen-Default). Reagiert auf `streamsIn`; die
  // openedTiles-Reads laufen in `untrack`, damit das Öffnen keine Schleife baut.
  $effect(() => {
    const cid = channel.id;
    const tiles = streamPresence.streamsIn(cid);
    untrack(() => {
      const me = currentServerUserId();
      for (const s of tiles) {
        if (s.user_id === me) continue;
        const id = hqTileId(s.user_id, s.slot);
        if (openedTiles.isOpen('hq', cid, id)) continue;
        const alreadyWatchingStreamer = tiles.some(
          (t) =>
            t.user_id === s.user_id &&
            openedTiles.isOpen('hq', cid, hqTileId(t.user_id, t.slot))
        );
        if (alreadyWatchingStreamer) openedTiles.open('hq', cid, id);
      }
    });
  });

  let memberListOpen = $state(false);
  function toggleMemberList(): void {
    memberListOpen = !memberListOpen;
  }

  // Subscription auf chat:channel:<cid>, damit `stream_chat_message`-Events
  // (per-Channel via `_subs` gefiltert) hier ankommen.
  $effect(() => {
    const cid = channel.id;
    gateway.subscribe(cid);
    return () => gateway.unsubscribe(cid);
  });
  // Prefetch names so tile/badge tooltips show display names, not `…`.
  $effect(() => {
    for (const uid of hqStreamers) userCache.queue(uid);
    for (const uid of screenSharerIds) userCache.queue(uid);
  });

  // Connecting must happen from a user gesture so the browser allows the
  // AudioContext to start. On desktop the "Beitreten"-Button provides that
  // gesture. On mobile the channel-list tap IS the gesture — der gegardete
  // Auto-Join-Effekt der Kanal-Seite (+page) nutzt diese Aktivierung.
  async function joinChannel() {
    try {
      await voice.connect(channel.id, channel.name);
    } catch (e) {
      toast.error(m.voice_channel_view_toast_connect_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // KEIN Auto-Join hier: Diese Ansicht wird bei jedem Mount neu bewertet —
  // auch nach dem Auflegen, wenn der Mobile-Voice-Stapel zur Vollbild-Ansicht
  // zurückwechselt. Ein Join im onMount hätte die Verbindung SOFORT wieder
  // aufgebaut („Auflegen → Connecting"-Loop) und kollidierte zudem mit dem
  // gegardeten Auto-Join der Kanal-Seite (doppelte Identity = Kick-Zyklus).
  // Landing-Auto-Join macht exklusiv der $effect in der +page (Guard pro
  // Kanal), Wiedereintritt nach dem Auflegen der „Beitreten"-Knopf.

  let isThisChannel = $derived(voice.channelId === channel.id);
  let statusLabel = $derived(
    voice.connecting
      ? m.voice_channel_view_status_connecting()
      : voice.connected
        ? m.voice_channel_view_status_connected({ count: voice.participants.length })
        : voice.error
          ? m.voice_channel_view_status_error({ error: voice.error })
          : m.voice_channel_view_status_disconnected()
  );

  function isTypingTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }
  let pttPressed = false;
  function handlePttKeydown(detail: ShortcutEventDetail) {
    const ev = detail.originalEvent;
    if (!voice.pttMode || ev.repeat || isTypingTarget(ev.target)) return;
    ev.preventDefault();
    pttPressed = true;
    voice.pttPress();
  }
  function handlePttKeyup(e: KeyboardEvent) {
    if (!voice.pttMode) return;
    // Ensure case-insensitive comparison consistent with the shortcut binding and setPttKey normalization
    const normalizedKey = e.key.toLowerCase();
    if (normalizedKey !== settings.voice.pttKey) return;
    if (!pttPressed) return;
    pttPressed = false;
    voice.pttRelease();
  }
</script>

<svelte:window
  use:shortcut={{
    type: 'keydown',
    trigger: { key: settings.voice.pttKey, modifier: false, callback: handlePttKeydown }
  }}
  onkeyup={handlePttKeyup}
  onblur={() => { if (voice.pttMode) { voice.pttRelease(); pttPressed = false; } }}
  onvisibilitychange={() => { if (document.visibilityState === 'hidden' && voice.pttMode) { voice.pttRelease(); pttPressed = false; } }}
/>

<section class="glass-panel slide-rein relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl" data-testid="voice-channel-view">
  <!-- Mobil verschwindet die Kopfzeile, sobald ein Stream läuft: der Bildschirm
       gehört dann dem Video, Navigation übernimmt die Bereichs-Leiste unten.
       Zurück bleibt der Kopf für den Normalzustand (Kacheln, nicht verbunden). -->
  <header
    class="flex h-14 items-center gap-2.5 px-3 md:px-5 {viewport.istHandy &&
    streamViewOpen &&
    isThisChannel &&
    (voice.connected || voice.connecting)
      ? 'hidden'
      : ''}"
  >
    <!-- Mobil: Zurück in die Raum-Ansicht desselben Raums (Kanalliste) —
         nicht in die Räume-ÜBERSICHT; gleiche Tiefe wie der Pfeil im
         Textkanal (ChatView.onBack → /app/rooms/[guildId]). -->
    <Button
      variant="ghost"
      size="icon"
      class="md:hidden"
      onclick={() => goto(`/app/rooms/${channel.guild_id}`)}
      aria-label={m.channel_list_back()}
      data-testid="voice-back-mobile"
    >
      <ChevronLeftIcon class="size-6" />
    </Button>
    <Volume2Icon class="text-primary size-5 shrink-0 max-md:hidden" />
    <!-- **Das Thema des Kanals** (2026-08-16). Es liess sich in den
         Kanal-Einstellungen setzen, wurde aber nur in der Kopfzeile eines
         TEXTkanals gezeigt (`ChatView.svelte`) — bei einem Sprachkanal stand es
         nirgends, das Feld war also eine Eingabe ins Nichts. Seit 2026-08-19
         steht es eine Zeile tiefer (`ChannelHeading.svelte`), damit
         „verbunden"/„nicht verbunden" die erste Auskunft neben dem Namen bleibt
         und nicht zwei Bruchstücke hintereinander in derselben Zeile hängen. -->
    <ChannelHeading name={channel.name} topic={channel.topic} meta={statusLabel} />
    <div class="ml-auto flex items-center gap-1">
      {#if !viewport.istHandy}
        <Button
          variant="ghost"
          size="icon"
          class="max-md:hidden"
          onclick={toggleMemberList}
          aria-label={m.voice_channel_view_toggle_member_list_aria()}
          data-testid="member-list-toggle"
        >
          <UsersIcon class="text-text-muted size-4" />
        </Button>
      {/if}
    </div>
  </header>

  {#if voice.audioBlocked && isThisChannel}
    <div class="absolute inset-0 z-10 flex items-center justify-center bg-foreground/30 backdrop-blur-md" data-testid="audio-blocked-overlay">
      <div class="bg-bg-chat flex flex-col items-center gap-3 rounded-2xl border border-border p-8 text-center shadow-2xl backdrop-blur-xl">
        <VolumeXIcon class="text-text-muted size-10" />
        <p class="text-text-bright text-sm font-medium">{m.voice_channel_view_audio_blocked_title()}</p>
        <p class="text-text-muted text-xs">{m.voice_channel_view_audio_blocked_hint()}</p>
        <Button onclick={() => void voice.unblockAudio()} data-testid="audio-unblock-btn">
          {m.voice_channel_view_audio_enable()}
        </Button>
      </div>
    </div>
  {/if}

  <div class="relative flex min-h-0 flex-1">
   <!-- min-w-0: ohne es bläht der ausgeklappte Teilnehmer-Streifen diese
        Spalte (und mit ihr den Stream) über den Bildschirm auf — rechts
        wurden Stream-Rand und Schließen-X abgeschnitten. -->
   <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if isThisChannel && (voice.connected || voice.connecting)}
    {#if voice.participants.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center gap-4 p-3">
        <p class="text-text-muted text-sm">{m.voice_channel_view_connecting_channel()}</p>
        <!-- Mobil ist diese Vollbild-Ansicht die einzige Oberfläche, solange
             das Dock nicht da ist — ein hängendes „Verbinde…" ohne Fluchtweg
             schloss den Nutzer ein (serverseitig war der Teilnehmer längst
             weg, der Client hing im Connecting). Verlassen ist immer da. -->        {#if viewport.isMobile}
          <Button
            variant="secondary"
            onclick={() => void voice.disconnect().catch(() => undefined)}
            data-testid="voice-leave-mobile"
          >
            {m.voice_bar_leave()}
          </Button>
        {/if}
      </div>
      {:else if streamViewOpen}
        <StreamGrid {channel} />
      {:else}
        <div class="flex flex-1 flex-col items-center justify-center gap-4 p-3 md:gap-6 md:p-8">
          <div class="flex flex-wrap items-center justify-center gap-4 md:gap-6" data-testid="voice-participants">
            {#each voice.participants as p (p.identity)}
              <VoiceParticipantTile {p} channelId={channel.id} guildId={channel.guild_id} />
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <div class="flex flex-1 items-center justify-center">
        <div class="text-center">
          <Volume2Icon class="text-text-muted mx-auto mb-3 size-12" />
          <p class="text-text-bright mb-1 text-lg">{channel.name}</p>
          <FieldError message={voice.error} class="mt-2" />
          {#if !viewport.isMobile}
            <p class="text-text-muted text-sm">{m.voice_channel_view_join_hint()}</p>
            <Button class="mt-4" onclick={joinChannel} data-testid="voice-join">{m.voice_channel_view_join_btn()}</Button>
          {:else}
            <!-- Nach dem Trennen steht hier bewusst „Nicht verbunden" — vorher
                 stand der Connecting-Text, und der Bildschirm sah nach dem
                 Auflegen aus wie eine hängende Verbindung. -->
            <p class="text-text-muted text-sm">{m.voice_channel_view_status_disconnected()}</p>
            <Button
              variant="secondary"
              class="mt-4"
              onclick={joinChannel}
              data-testid="voice-join-mobile"
            >
              {m.voice_channel_view_join_btn()}
            </Button>
          {/if}
        </div>
      </div>
    {/if}
   </div>

    <!-- Rechter Slot inline (md+) — nur Mitgliederliste. Stream- und Watch-
         Chats leben jetzt INNERHALB des jeweiligen Stream-Tiles. -->
    {#if !viewport.istHandy && memberListOpen}
      <MemberList guildId={channel.guild_id} />
    {/if}
  </div>

</section>
