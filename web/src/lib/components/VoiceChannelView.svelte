<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import StreamGrid from './StreamGrid.svelte';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import MemberList from './MemberList.svelte';
  import { gateway } from '$lib/ws/connection';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import UsersIcon from '@lucide/svelte/icons/users';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import PlayIcon from '@lucide/svelte/icons/play';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { hiddenTiles } from '$lib/stream/hiddenTiles.svelte';
  import { streamOpenRequest } from '$lib/stores/streamOpenRequest.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { shortcut, type ShortcutEventDetail } from '@svelte-put/shortcut';
  import { untrack } from 'svelte';
  import MenuIcon from '@lucide/svelte/icons/menu';
  import type { Channel } from '$lib/api/types';

  let {
    channel,
    onMenuClick
  }: {
    channel: Channel;
    onMenuClick?: () => void;
  } = $props();

  // HQ stream presence for this channel (from the WS `stream_state` broadcast) —
  // a set of streamers, since several people can HQ-stream into one channel.
  let hqStreamers = $derived(streamPresence.streamersIn(channel.id));
  let iAmHqStreaming = $derived(!!auth.user && hqStreamers.includes(auth.user.id));
  // The streams whose video we can actually watch (everyone but ourselves),
  // minus the ones the viewer has dismissed locally.
  let hqStreamersOther = $derived(
    hqStreamers.filter(
      (id) => id !== auth.user?.id && !hiddenTiles.has('hq', channel.id, id)
    )
  );
  let hqStreaming = $derived(hqStreamers.length > 0);

  // Browser screen-share publishers for this channel (from LiveKit webhooks via
  // voice:events) — same chat-eligibility as HQ streamers (backend gates on
  // EITHER source). HQ goes first in the combined list so it wins focus when
  // both are present in the same channel.
  let screenSharers = $derived(voicePresence.streamingIn(channel.id));
  let liveStreamers = $derived([
    ...hqStreamers,
    ...screenSharers.filter((id) => !hqStreamers.includes(id))
  ]);
  let liveStreamersOther = $derived(liveStreamers.filter((id) => id !== auth.user?.id));

  // Watch-Party (max 1 pro Channel, parallel zu HQ/Screenshare). Quelle ist
  // ein gemeinsam synchronisiertes Video (YouTube/Twitch-VOD/Direct-Link).
  let rawWatchPartyState = $derived(watchPartyPresence.partyIn(channel.id));
  let watchPartyHidden = $derived(hiddenTiles.has('party', channel.id, '_'));
  let watchPartyState = $derived(watchPartyHidden ? undefined : rawWatchPartyState);
  let hasWatchParty = $derived(watchPartyState !== undefined);

  // Visible (not locally hidden) cams + browser-screenshares for this channel.
  // Viewers can dismiss individual tiles, so the open-state derivations must
  // use the filtered lists rather than the raw voice.cameraTracks/screenTracks.
  let visibleCameras = $derived(
    voice.cameraTracks.filter((c) => !hiddenTiles.has('cam', channel.id, c.identity))
  );
  let visibleScreenShares = $derived(
    voice.screenTracks.filter((s) => !hiddenTiles.has('screen', channel.id, s.identity))
  );

  // Stream layout: every watchable HQ stream + every browser screen-share +
  // every remote camera + any watch-party go into one responsive grid (all
  // filtered through hiddenTiles); participant avatars become a compact row
  // below.
  let hasStreams = $derived(
    hqStreamersOther.length > 0 || visibleScreenShares.length > 0 || visibleCameras.length > 0
  );

  // Live-Streamer-Namen für den Banner (HQ + Browser-Screenshare, ohne self).
  // `liveStreamersOther` ist die kanonische User-ID-Liste — `voice.screenTracks`
  // wäre identity-basiert und kann während Subscribe-Sync abweichen.
  // Banner + auto-open trigger: any of HQ-others, screen-share-others, or a
  // watch-party in this channel counts as "etwas Sehenswertes läuft".
  let othersStreaming = $derived(
    hqStreamersOther.length > 0 ||
      visibleScreenShares.length > 0 ||
      visibleCameras.length > 0 ||
      hasWatchParty
  );
  let streamBannerLabel = $derived.by(() => {
    if (hasWatchParty && liveStreamersOther.length === 0) return 'Watch Party läuft';
    if (hasWatchParty && liveStreamersOther.length > 0) return 'Watch Party + Streams laufen';
    const ids = liveStreamersOther;
    if (ids.length === 1) return `${userCache.displayName(ids[0])} streamt`;
    if (ids.length === 2)
      return `${userCache.displayName(ids[0])} und ${userCache.displayName(ids[1])} streamen`;
    return `${userCache.displayName(ids[0])} und ${ids.length - 1} weitere streamen`;
  });

  // Stream-Grid wird nur explizit auf Klick gemountet — Default ist die
  // Teilnehmer-Ansicht. Verhindert dass WHEP-Handshakes (Bandbreite!) und der
  // Player automatisch starten nur weil jemand im Channel pusht.
  let streamViewOpen = $state(false);
  // Wenn gesetzt, blendet das Grid nur die Kacheln dieses Users ein — wird vom
  // streamOpenRequest gefüttert wenn der Klick einen spezifischen LIVE-Badge
  // adressiert hat („öffne nur Person X"). Klick aufs in-Channel-Banner +
  // sonstige Wege lassen das auf null und zeigen alles.
  let focusUid = $state<string | null>(null);

  // Reset auf collapsed bei Channel-Wechsel + jegliche User-spezifischen Hide-
  // Flags wegwerfen, sodass ein Re-Join nicht mit alter „Cam X ausgeblendet"-
  // Erinnerung startet. WICHTIG: `resetChannel` selbst LIEST + SCHREIBT
  // hiddenTiles' interne Set-Rune — ohne `untrack` würde der Effekt dadurch
  // bei jedem Hide-Klick re-firen und `streamViewOpen=false` setzen (=
  // Symptom: Tile-X klickt → Grid kollabiert → User denkt er wurde gekickt).
  $effect(() => {
    const cid = channel.id;
    streamViewOpen = false;
    focusUid = null;
    untrack(() => hiddenTiles.resetChannel(cid));
  });

  // Sidebar-LIVE-Badge: setzt streamOpenRequest. Effekt tracked das +
  // channel.id, sodass beides Quellen für ein Re-Run sind (Klick auf LIVE im
  // aktuellen Channel = pending ändert sich ohne Navigation). Consume in
  // untrack, damit das Clearen des #pending nicht denselben Effekt sofort
  // wieder triggert.
  $effect(() => {
    void streamOpenRequest.pending;
    const cid = channel.id;
    const consumed = untrack(() => streamOpenRequest.consume(cid));
    if (consumed) {
      streamViewOpen = true;
      focusUid = consumed.focusUid;
    }
  });

  $effect(() => {
    if (!othersStreaming) streamViewOpen = false;
  });

  // Auto-open the grid for the host on the transition into an active party:
  // they just clicked Start, they should see their own tile + the stop X
  // immediately without having to click the banner. Viewers still consent
  // via the banner.
  let prevHadParty = false;
  $effect(() => {
    const has = hasWatchParty;
    const iAmHost = !!watchPartyState && !!auth.user && watchPartyState.host_user_id === auth.user.id;
    if (has && !prevHadParty && iAmHost) streamViewOpen = true;
    prevHadParty = has;
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
  let hqLabel = $derived.by(() => {
    const others = hqStreamersOther.length;
    if (iAmHqStreaming) {
      if (others === 0) return 'Du streamst (HQ)';
      if (others === 1) return `Du und ${userCache.displayName(hqStreamersOther[0])} streamen (HQ)`;
      return `Du und ${others} weitere streamen (HQ)`;
    }
    if (others === 1) return `${userCache.displayName(hqStreamersOther[0])} streamt (HQ)`;
    return `${others} Leute streamen (HQ)`;
  });

  $effect(() => {
    for (const uid of liveStreamers) userCache.queue(uid);
  });

  // Connecting must happen from a user gesture (click on "Beitreten") so the
  // browser allows the AudioContext to start — auto-connect on mount would be
  // blocked by autoplay policy.
  async function joinChannel() {
    try {
      await voice.connect(channel.id, channel.name);
    } catch (e) {
      toast.error('Voice-Verbindung fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }

  let isThisChannel = $derived(voice.channelId === channel.id);
  let statusLabel = $derived(
    voice.connecting
      ? 'Verbinde…'
      : voice.connected
        ? `Sprach-Kanal · ${voice.participants.length} ${voice.participants.length === 1 ? 'Teilnehmer' : 'Teilnehmer'}`
        : voice.error
          ? `Fehler: ${voice.error}`
          : 'Nicht verbunden'
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
    if (!voice.pttMode || e.key.toLowerCase() !== settings.voice.pttKey) return;
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
  onblur={() => { if (voice.pttMode) voice.pttRelease(); }}
  onvisibilitychange={() => { if (document.visibilityState === 'hidden' && voice.pttMode) voice.pttRelease(); }}
/>

<section class="glass-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl" data-testid="voice-channel-view">
  <header class="flex h-14 items-center gap-2.5 px-3 md:px-5">
    {#if onMenuClick}
      <button
        class="mr-1 rounded-full p-2 transition-colors hover:bg-bg-hover hover:text-primary md:hidden"
        onclick={onMenuClick}
        aria-label="Menü"
        data-testid="mobile-menu-toggle"
      >
        <MenuIcon class="text-text-muted size-4" />
      </button>
    {/if}
    <Volume2Icon class="text-primary size-5 shrink-0" />
    <span class="text-text-bright truncate text-base font-semibold tracking-tight md:text-lg" data-testid="active-channel-name">{channel.name}</span>
    <span class="text-text-muted ml-2 hidden truncate text-sm md:block">· {statusLabel}</span>
    <div class="ml-auto flex items-center gap-1">
      {#if streamViewOpen && othersStreaming}
        {#if focusUid}
          <button
            class="bg-bg-input/70 text-text-bright hover:bg-bg-hover hover:text-primary flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors"
            onclick={() => (focusUid = null)}
            aria-label="Alle Streams im Kanal anzeigen"
            title="Alle anzeigen"
            data-testid="stream-grid-show-all"
          >
            <span class="hidden sm:inline">Alle Streams anzeigen</span>
            <span class="sm:hidden">Alle</span>
          </button>
        {/if}
        <button
          class="bg-bg-input/70 text-text-bright hover:bg-bg-hover hover:text-primary flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors"
          onclick={() => { streamViewOpen = false; focusUid = null; }}
          aria-label="Zurück zur Teilnehmer-Ansicht"
          title="Teilnehmer-Ansicht"
          data-testid="stream-grid-close"
        >
          <ArrowLeftIcon class="size-3.5" />
          <span class="hidden sm:inline">Streams ausblenden</span>
          <span class="sm:hidden">Zurück</span>
        </button>
      {/if}
      <button
        class="rounded-full p-2 transition-colors hover:bg-bg-hover hover:text-primary"
        onclick={toggleMemberList}
        aria-label="Mitgliederliste umschalten"
        data-testid="member-list-toggle"
      >
        <UsersIcon class="text-text-muted size-4" />
      </button>
    </div>
  </header>

  {#if voice.audioBlocked && isThisChannel}
    <div class="absolute inset-0 z-10 flex items-center justify-center bg-foreground/30 backdrop-blur-md" data-testid="audio-blocked-overlay">
      <div class="bg-bg-chat flex flex-col items-center gap-3 rounded-2xl border border-border p-8 text-center shadow-2xl backdrop-blur-xl">
        <VolumeXIcon class="text-text-muted size-10" />
        <p class="text-text-bright text-sm font-medium">Audio ist stummgeschaltet</p>
        <p class="text-text-muted text-xs">Dein Browser blockiert die automatische Wiedergabe.</p>
        <Button onclick={() => void voice.unblockAudio()} data-testid="audio-unblock-btn">
          Audio aktivieren
        </Button>
      </div>
    </div>
  {/if}

  <div class="relative flex min-h-0 flex-1">
   <div class="flex min-h-0 flex-1 flex-col">
    {#if isThisChannel && (voice.connected || voice.connecting)}
      {#if voice.participants.length === 0}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-text-muted text-sm">Verbinde mit dem Sprach-Kanal…</p>
        </div>
      {:else if streamViewOpen && othersStreaming}
        <StreamGrid
          {channel}
          {hqStreaming}
          {hqStreamersOther}
          {hqLabel}
          {watchPartyState}
          {focusUid}
        />
      {:else}
        <div class="flex flex-1 flex-col items-center justify-center gap-4 p-3 md:gap-6 md:p-8">
          {#if othersStreaming}
            <button
              type="button"
              class="bg-primary/15 text-primary hover:bg-primary/25 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors"
              onclick={() => { streamViewOpen = true; focusUid = null; }}
              data-testid="voice-stream-open-banner"
            >
              <PlayIcon class="size-4" />
              <span>{streamBannerLabel} — ansehen</span>
            </button>
          {/if}
          <div class="flex flex-wrap items-center justify-center gap-4 md:gap-6" data-testid="voice-participants">
            {#each voice.participants as p (p.identity)}
              <VoiceParticipantTile {p} />
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <div class="flex flex-1 items-center justify-center">
        <div class="text-center">
          <Volume2Icon class="text-text-muted mx-auto mb-3 size-12" />
          <p class="text-text-bright mb-1 text-lg">{channel.name}</p>
          <p class="text-text-muted text-sm">Klicke „Beitreten", um dem Sprach-Kanal beizutreten.</p>
          {#if voice.error}
            <p class="mt-2 text-sm text-red-400">{voice.error}</p>
          {/if}
          <Button class="mt-4" onclick={joinChannel} data-testid="voice-join">Beitreten</Button>
        </div>
      </div>
    {/if}
   </div>

    <!-- Rechter Slot inline (md+) — nur Mitgliederliste. Stream- und Watch-
         Chats leben jetzt INNERHALB des jeweiligen Stream-Tiles. -->
    {#if !viewport.isMobile && memberListOpen}
      <MemberList guildId={channel.guild_id} />
    {/if}
  </div>

  <!-- Sheet von rechts auf Mobil — nur Mitgliederliste. -->
  {#if viewport.isMobile && memberListOpen}
    <div class="fixed inset-0 z-30 bg-black/40" role="presentation"
      onclick={() => (memberListOpen = false)}></div>
    <div class="fixed inset-y-0 right-0 z-40 flex w-4/5 max-w-xs flex-col">
      <MemberList guildId={channel.guild_id} onClose={() => (memberListOpen = false)} />
    </div>
  {/if}

</section>
