<script lang="ts">
  import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';

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

  let videoEl = $state<HTMLVideoElement | null>(null);
  let audioEl = $state<HTMLAudioElement | null>(null);
  let volume = $state(100);

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
    return () => { at.detach(el); };
  });

  function handleVolume(e: Event) {
    volume = Number((e.currentTarget as HTMLInputElement).value);
    audioTrack?.setVolume(volume / 100);
  }
</script>

<div
  class="bg-bg-chat relative flex h-full flex-col overflow-hidden rounded-lg border border-white/10"
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
    onclick={() => videoEl?.requestFullscreen()}
    title="Klicken für Vollbild"
  ></video>

  <!-- hidden audio element for screen-share audio track -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio bind:this={audioEl} autoplay style="display:none"></audio>

  <div class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-xs text-white">
    <MonitorIcon class="size-3" />
    <span class="max-w-32 truncate">{name}</span>
  </div>

  {#if audioTrack}
    <div class="absolute bottom-2 right-2 flex items-center gap-1.5 rounded bg-black/60 px-2 py-1">
      {#if volume === 0}
        <VolumeXIcon class="size-3 text-white" />
      {:else}
        <Volume2Icon class="size-3 text-white" />
      {/if}
      <input
        type="range"
        min="0"
        max="100"
        value={volume}
        oninput={handleVolume}
        class="w-20 accent-white"
        aria-label="Lautstärke des geteilten Bildschirms"
        data-testid="screen-share-volume"
      />
    </div>
  {/if}
</div>
