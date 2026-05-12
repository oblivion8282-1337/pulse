<script lang="ts">
  import { onMount } from 'svelte';
  import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import { voice } from '$lib/voice/livekit.svelte';
  import { toggleFullscreen, isDocFullscreen } from '$lib/stream/fullscreen';

  let {
    track,
    audioTrack,
    name,
    identity
  }: {
    track: RemoteVideoTrack;
    audioTrack?: RemoteAudioTrack;
    name: string;
    identity: string;
  } = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let audioEl = $state<HTMLAudioElement | null>(null);
  let volume = $state(100);
  // Remembers last non-zero volume so the mute toggle can restore it.
  let prevVolume = $state(100);
  let localBlocked = $state(false);
  let isFullscreen = $state(false);
  const audioBlocked = $derived(localBlocked || voice.audioBlocked);

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
    at.setVolume(volume / 100);
    el.play().then(() => { localBlocked = false; }).catch(() => { localBlocked = true; });
    return () => { at.detach(el); };
  });

  function handleVolume(e: Event) {
    volume = Number((e.currentTarget as HTMLInputElement).value);
    if (volume > 0) prevVolume = volume;
    audioTrack?.setVolume(volume / 100);
  }

  function toggleMute() {
    if (volume > 0) {
      prevVolume = volume;
      volume = 0;
    } else {
      volume = prevVolume > 0 ? prevVolume : 100;
    }
    audioTrack?.setVolume(volume / 100);
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
        max="100"
        value={volume}
        oninput={handleVolume}
        class="w-24 accent-white sm:w-20"
        aria-label="Lautstärke des geteilten Bildschirms"
        data-testid="screen-share-volume"
      />
    </div>
  {/if}
</div>
