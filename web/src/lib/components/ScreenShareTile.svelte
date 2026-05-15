<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import { voice } from '$lib/voice/livekit.svelte';
  import { toggleFullscreen, isDocFullscreen } from '$lib/stream/fullscreen';
  import { VolumeBoost, VOLUME_BOOST_MAX } from '$lib/stream/volumeBoost';
  import StreamChatOverlay from '$lib/stream/components/StreamChatOverlay.svelte';
  import StreamChatInlineInput from '$lib/stream/components/StreamChatInlineInput.svelte';

  let {
    channelId,
    streamerId,
    track,
    audioTrack,
    name,
    identity
  }: {
    /** Voice channel this share lives in — needed for the per-streamer chat. */
    channelId: string;
    /** User id parsed from the LiveKit identity. Null = unknown publisher (no chat). */
    streamerId: string | null;
    track: RemoteVideoTrack;
    audioTrack?: RemoteAudioTrack;
    name: string;
    identity: string;
  } = $props();

  // Twitch-style in-tile chat — mirrors WhepPlayer's chatOpen flow so the
  // overlay + inline input come along into fullscreen.
  let chatOpen = $state(false);

  let containerEl = $state<HTMLDivElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let audioEl = $state<HTMLAudioElement | null>(null);
  let volume = $state(100);
  // Remembers last non-zero volume so the mute toggle can restore it.
  let prevVolume = $state(100);
  let localBlocked = $state(false);
  let isFullscreen = $state(false);
  const audioBlocked = $derived(localBlocked || voice.audioBlocked);
  // Lazy Web-Audio-Routing für >100%-Boost — `audioTrack.setVolume()` würde
  // sonst nur el.volume setzen, das HTML-spec-seitig auf 1.0 gecappt ist.
  let boost: VolumeBoost | null = null;

  function applyVolume() {
    boost?.setVolume(volume / 100);
  }

  function handleToggleFullscreen() {
    toggleFullscreen(containerEl, videoEl);
  }

  $effect(() => {
    const t = track;
    const el = videoEl;
    if (!t || !el) return;
    t.attach(el);
    return () => { t.detach(el); };
  });

  $effect(() => {
    const at = audioTrack;
    const el = audioEl;
    if (!at || !el) return;
    at.attach(el);
    // Web-Audio-Graph einmalig anlegen — `createMediaElementSource(el)` wirft
    // beim zweiten Aufruf auf demselben Element. Beim Track-Wechsel reicht
    // re-attach, der Graph läuft weiter; dispose() passiert in onDestroy.
    if (!boost) boost = new VolumeBoost(el);
    applyVolume();
    el.play().then(() => { localBlocked = false; }).catch(() => { localBlocked = true; });
    return () => { at.detach(el); };
  });

  function handleVolume(e: Event) {
    volume = Number((e.currentTarget as HTMLInputElement).value);
    if (volume > 0) prevVolume = volume;
    applyVolume();
  }

  function toggleMute() {
    if (volume > 0) {
      prevVolume = volume;
      volume = 0;
    } else {
      volume = prevVolume > 0 ? prevVolume : 100;
    }
    applyVolume();
  }

  async function enableAudio() {
    await voice.unblockAudio();
    try {
      await audioEl?.play();
      localBlocked = false;
    } catch {
      /* still blocked — leave the button visible */
    }
  }

  onMount(() => {
    function onFsChange() {
      isFullscreen = isDocFullscreen();
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  });

  onDestroy(() => {
    boost?.dispose();
    boost = null;
  });
</script>

<div
  bind:this={containerEl}
  class="bg-bg-chat relative flex h-full flex-col overflow-hidden rounded-2xl border border-border"
  data-testid="screen-share-tile"
  data-identity={identity}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <video
    bind:this={videoEl}
    autoplay
    playsinline
    class="h-full w-full cursor-pointer object-contain"
    onclick={handleToggleFullscreen}
    title="Klicken für Vollbild / Esc zum Verlassen"
  ></video>

  <!-- hidden audio element for screen-share audio track -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio bind:this={audioEl} autoplay style="display:none"></audio>

  <div class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm">
    <MonitorIcon class="size-3" />
    <span class="max-w-32 truncate">{name}</span>
  </div>

  <!--
    Top-right corner: Maximize button always visible, "Ton aktivieren" below it
    when audioBlocked (and only when there is an audioTrack at all).
    Vertical stacking keeps both tappable simultaneously on touch screens.
  -->
  <div class="absolute right-2 top-2 flex flex-col items-end gap-1.5">
    {#if streamerId}
      <button
        type="button"
        onclick={() => (chatOpen = !chatOpen)}
        class="flex items-center justify-center rounded-full p-1.5 text-white backdrop-blur-sm hover:bg-black/75 {chatOpen ? 'bg-primary/80' : 'bg-black/55'}"
        aria-label="Live-Chat"
        aria-pressed={chatOpen}
        title="Live-Chat"
        data-testid="screen-share-chat-toggle"
      >
        <MessageSquareIcon class="size-3.5" />
      </button>
    {/if}

    <button
      type="button"
      onclick={handleToggleFullscreen}
      class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75"
      aria-label={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
      title={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
      data-testid="screen-share-fullscreen"
    >
      {#if isFullscreen}
        <MinimizeIcon class="size-3.5" />
      {:else}
        <MaximizeIcon class="size-3.5" />
      {/if}
    </button>

    {#if audioTrack && audioBlocked}
      <button
        type="button"
        onclick={enableAudio}
        class="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500"
        data-testid="screen-share-unblock-audio"
      >Ton aktivieren</button>
    {/if}
  </div>

  {#if chatOpen && streamerId}
    <StreamChatOverlay {channelId} {streamerId} />
    <StreamChatInlineInput {channelId} {streamerId} />
  {/if}

  {#if audioTrack}
    <div class="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur-sm">
      <button
        type="button"
        onclick={toggleMute}
        class="flex items-center text-white hover:text-white/70"
        aria-label={volume === 0 ? 'Ton an' : 'Stummschalten'}
        data-testid="screen-share-mute"
      >
        {#if volume === 0}
          <VolumeXIcon class="size-3" />
        {:else}
          <Volume2Icon class="size-3" />
        {/if}
      </button>
      <input
        type="range"
        min="0"
        max={VOLUME_BOOST_MAX}
        value={volume}
        oninput={handleVolume}
        class="w-24 accent-white sm:w-20"
        aria-label="Lautstärke des geteilten Bildschirms"
        title="{volume}%"
        data-testid="screen-share-volume"
      />
    </div>
  {/if}
</div>
