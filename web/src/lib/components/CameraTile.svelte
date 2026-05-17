<script lang="ts">
  import { onMount } from 'svelte';
  import type { RemoteVideoTrack } from 'livekit-client';
  import VideoIcon from '@lucide/svelte/icons/video';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import XIcon from '@lucide/svelte/icons/x';
  import { toggleFullscreen, isDocFullscreen } from '$lib/stream/fullscreen';
  import { hiddenTiles } from '$lib/stream/hiddenTiles.svelte';

  let {
    channelId,
    track,
    name,
    identity
  }: {
    channelId: string;
    track: RemoteVideoTrack;
    name: string;
    identity: string;
  } = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let isFullscreen = $state(false);

  $effect(() => {
    const t = track;
    const el = videoEl;
    if (!t || !el) return;
    t.attach(el);
    return () => { t.detach(el); };
  });

  function handleToggleFullscreen() {
    toggleFullscreen(containerEl, videoEl);
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
  class="bg-bg-chat relative flex h-full overflow-hidden rounded-2xl border border-border"
  data-testid="camera-tile"
  data-identity={identity}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <video
    bind:this={videoEl}
    autoplay
    playsinline
    class="h-full w-full cursor-pointer object-cover"
    onclick={handleToggleFullscreen}
    title="Klicken für Vollbild / Esc zum Verlassen"
  ></video>

  <div class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm">
    <VideoIcon class="size-3" />
    <span class="max-w-32 truncate">{name}</span>
  </div>

  <button
    type="button"
    onclick={() => hiddenTiles.hide('cam', channelId, identity)}
    class="absolute right-2 top-2 flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-red-600"
    aria-label="Kamera ausblenden"
    title="Diese Kamera ausblenden"
    data-testid="camera-hide"
  >
    <XIcon class="size-3.5" />
  </button>

  <div class="absolute bottom-2 right-2 flex items-center gap-1.5">
    <button
      type="button"
      onclick={handleToggleFullscreen}
      class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75"
      aria-label={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
      title={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
      data-testid="camera-fullscreen"
    >
      {#if isFullscreen}
        <MinimizeIcon class="size-3.5" />
      {:else}
        <MaximizeIcon class="size-3.5" />
      {/if}
    </button>
  </div>
</div>
