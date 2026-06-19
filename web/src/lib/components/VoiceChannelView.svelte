<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import StreamGrid from './StreamGrid.svelte';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import MemberList from './MemberList.svelte';
  import { gateway } from '$lib/ws/connection';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import UsersIcon from '@lucide/svelte/icons/users';
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
  import { watchBackground } from '$lib/watch/watchBackground.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { shortcut, type ShortcutEventDetail } from '@svelte-put/shortcut';
  import { untrack, onMount } from 'svelte';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  // HQ stream presence for this channel — needed by the prune effect below
  // so that a publisher who stopped doesn't keep auto-mounting a tile.
  let hqStreamers = $derived(streamPresence.streamersIn(channel.id));
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
    const hqSet = new Set(hqStreamers);
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
  // gesture. On mobile the channel-list tap IS the gesture — SPA navigation
  // keeps the user-activation alive into onMount, so we auto-join there.
  async function joinChannel() {
    try {
      await voice.connect(channel.id, channel.name);
    } catch (e) {
      toast.error(m.voice_channel_view_toast_connect_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    }
  }

  onMount(() => {
    if (viewport.isMobile && !voice.connected && !voice.connecting) {
      void joinChannel();
    }
  });

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

<section class="glass-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl" data-testid="voice-channel-view">
  <header class="flex h-14 items-center gap-2.5 px-3 md:px-5">
    <Volume2Icon class="text-primary size-5 shrink-0" />
    <span class="text-text-bright truncate text-lg font-semibold tracking-tight" data-testid="active-channel-name">{channel.name}</span>
    <span class="text-text-muted ml-2 hidden truncate text-sm md:block">· {statusLabel}</span>
    <div class="ml-auto flex items-center gap-1">
      <button
        class="rounded-full p-2.5 transition-colors md:p-2 hover:bg-bg-hover hover:text-primary max-md:hidden"
        onclick={toggleMemberList}
        aria-label={m.voice_channel_view_toggle_member_list_aria()}
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
        <p class="text-text-bright text-sm font-medium">{m.voice_channel_view_audio_blocked_title()}</p>
        <p class="text-text-muted text-xs">{m.voice_channel_view_audio_blocked_hint()}</p>
        <Button onclick={() => void voice.unblockAudio()} data-testid="audio-unblock-btn">
          {m.voice_channel_view_audio_enable()}
        </Button>
      </div>
    </div>
  {/if}

  <div class="relative flex min-h-0 flex-1">
   <div class="flex min-h-0 flex-1 flex-col">
    {#if isThisChannel && (voice.connected || voice.connecting)}
      {#if voice.participants.length === 0}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-text-muted text-sm">{m.voice_channel_view_connecting_channel()}</p>
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
          {#if voice.error}
            <p class="mt-2 text-sm text-red-400">{voice.error}</p>
          {/if}
          {#if !viewport.isMobile}
            <p class="text-text-muted text-sm">{m.voice_channel_view_join_hint()}</p>
            <Button class="mt-4" onclick={joinChannel} data-testid="voice-join">{m.voice_channel_view_join_btn()}</Button>
          {:else}
            <p class="text-text-muted text-sm">{m.voice_channel_view_status_connecting()}</p>
          {/if}
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

</section>
