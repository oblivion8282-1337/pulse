<script lang="ts">
  import type { RemoteVideoTrack } from 'livekit-client';
  import MonitorIcon from '@lucide/svelte/icons/monitor';

  let {
    track,
    name,
    identity
  }: {
    track: RemoteVideoTrack;
    name: string;
    identity: string;
  } = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);

  $effect(() => {
    const t = track;
    const el = videoEl;
    if (!t || !el) return;
    t.attach(el);
    return () => {
      t.detach(el);
    };
  });
</script>

<div
  class="bg-bg-chat relative flex flex-col overflow-hidden rounded-lg border border-white/10"
  data-testid="screen-share-tile"
  data-identity={identity}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <video
    bind:this={videoEl}
    autoplay
    playsinline
    class="w-full cursor-pointer object-contain"
    style="aspect-ratio: 16/9;"
    onclick={() => videoEl?.requestFullscreen()}
    title="Klicken für Vollbild"
  ></video>
  <div class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 text-xs text-white">
    <MonitorIcon class="size-3" />
    <span class="max-w-32 truncate">{name}</span>
  </div>
</div>
