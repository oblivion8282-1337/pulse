<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import VoiceParticipantTile from './VoiceParticipantTile.svelte';
  import ScreenShareTile from './ScreenShareTile.svelte';
  import VoiceControlBar from './VoiceControlBar.svelte';
  import WhepPlayer from '$lib/stream/components/WhepPlayer.svelte';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
  import SquareIcon from '@lucide/svelte/icons/square';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { gsr } from '$lib/stream/gsr';
  import { shortcut, type ShortcutEventDetail } from '@svelte-put/shortcut';
  import type { Channel } from '$lib/api/types';

  let { channel }: { channel: Channel } = $props();

  // HQ stream presence for this channel (from the WS `stream_state` broadcast).
  let hqStreaming = $derived(streamPresence.isStreaming(channel.id));
  let hqStreamerId = $derived(streamPresence.streamingUser(channel.id));
  let hqIsSelf = $derived(!!hqStreamerId && hqStreamerId === auth.user?.id);
  let hqStreamerName = $derived(hqStreamerId ? userCache.displayName(hqStreamerId) : 'Jemand');
  $effect(() => {
    if (hqStreamerId) userCache.queue(hqStreamerId);
  });

  async function stopHqStream() {
    try {
      await gsr.stop();
    } catch {
      /* the WS broadcast will reflect the real state either way */
    }
  }

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
  function handlePttKeydown(detail: ShortcutEventDetail) {
    const ev = detail.originalEvent;
    if (!voice.pttMode || ev.repeat || isTypingTarget(ev.target)) return;
    ev.preventDefault();
    voice.pttPress();
  }
  function handlePttKeyup(e: KeyboardEvent) {
    if (!voice.pttMode || e.key.toLowerCase() !== settings.voice.pttKey) return;
    if (isTypingTarget(e.target)) return;
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

<section class="glass-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-2xl" data-testid="voice-channel-view">
  <header class="flex h-14 items-center gap-2.5 px-5">
    <Volume2Icon class="text-primary size-5" />
    <span class="text-text-bright text-lg font-semibold tracking-tight" data-testid="active-channel-name">{channel.name}</span>
    <span class="text-text-muted ml-2 text-sm">· {statusLabel}</span>
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

  <div class="flex min-h-0 flex-1 flex-col">
    {#if isThisChannel && (voice.connected || voice.connecting)}
      {#if voice.participants.length === 0}
        <div class="flex flex-1 items-center justify-center">
          <p class="text-text-muted text-sm">Verbinde mit dem Sprach-Kanal…</p>
        </div>
      {:else if hqStreaming}
        <div class="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="hq-stream-area">
          <div class="flex shrink-0 items-center gap-2 text-sm" data-testid="hq-stream-label">
            <RadioTowerIcon class="size-4 text-red-500" />
            {#if hqIsSelf}
              <span class="text-text-bright font-medium">Du streamst (HQ)</span>
              <Button
                variant="destructive"
                size="sm"
                class="ml-auto gap-1.5"
                onclick={stopHqStream}
                data-testid="hq-stream-stop-btn"
              >
                <SquareIcon class="size-3.5" />
                Stream beenden
              </Button>
            {:else}
              <span class="text-text-bright"><span class="font-medium">{hqStreamerName}</span> streamt (HQ)</span>
            {/if}
          </div>
          {#if hqIsSelf}
            <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-bg-chat text-center" data-testid="hq-stream-self-indicator">
              <RadioTowerIcon class="size-10 text-red-500" />
              <p class="text-text-bright text-sm font-medium">Du streamst in diesen Kanal</p>
              <p class="text-text-muted text-xs">Deine eigene Wiedergabe wird hier nicht angezeigt.</p>
            </div>
          {:else}
            <div class="min-h-0 flex-1">
              <WhepPlayer channelId={channel.id} />
            </div>
          {/if}
          {#if voice.screenTracks.length > 0}
            {#each voice.screenTracks as st (st.identity)}
              <div class="h-40 shrink-0">
                <ScreenShareTile track={st.track} audioTrack={st.audioTrack} name={st.name} identity={st.identity} />
              </div>
            {/each}
          {/if}
          <div class="flex shrink-0 flex-wrap items-center justify-center gap-4 py-2" data-testid="voice-participants">
            {#each voice.participants as p (p.identity)}
              <VoiceParticipantTile {p} />
            {/each}
          </div>
        </div>
      {:else if voice.screenTracks.length > 0}
        <div class="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="screen-share-area">
          {#each voice.screenTracks as st (st.identity)}
            <ScreenShareTile track={st.track} audioTrack={st.audioTrack} name={st.name} identity={st.identity} />
          {/each}
          <div class="flex shrink-0 flex-wrap items-center justify-center gap-4 py-2" data-testid="voice-participants">
            {#each voice.participants as p (p.identity)}
              <VoiceParticipantTile {p} />
            {/each}
          </div>
        </div>
      {:else}
        <div class="flex flex-1 flex-wrap items-center justify-center gap-6 p-8" data-testid="voice-participants">
          {#each voice.participants as p (p.identity)}
            <VoiceParticipantTile {p} />
          {/each}
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

  {#if isThisChannel && (voice.connected || voice.connecting)}
    <Separator />
    <VoiceControlBar />
  {/if}
</section>
