<!--
  ScreenShareDocPipView — Render-Ziel im Document-Picture-in-Picture-Fenster.
  Wird vom `ScreenShareTile` imperativ via `mount()` ins PiP-Window
  eingehängt. Bekommt den LiveKit-`RemoteVideoTrack` direkt als Prop —
  selber JS-Context wie das Hauptfenster, daher keine Cross-Window-Bridge
  nötig. Mehrfach-`attach()` an dieselbe Track ist von LiveKit erlaubt; in
  diesem Pfad ist das Haupt-Tile aber gerade durch einen Placeholder ersetzt,
  d.h. seine Attach-Effekte sind via Svelte-Unmount sauber aufgeräumt.

  Audio bleibt aus diesem Fenster heraus — der LK-Audio-Track läuft im
  Hauptfenster weiter (oder im Voice-Connection-Slot). Doppelt abspielen
  wäre Echo, einseitig stummschalten würde State-Sync brauchen den wir uns
  hier sparen.
-->
<script lang="ts">
  import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import StreamChatPanel from '$lib/stream/components/StreamChatPanel.svelte';

  let {
    track,
    audioTrack,
    streamerId,
    channelId,
    name,
    onReattach
  }: {
    track: RemoteVideoTrack;
    audioTrack?: RemoteAudioTrack;
    streamerId: string | null;
    channelId: string;
    name: string;
    onReattach: () => void;
  } = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let audioEl = $state<HTMLAudioElement | null>(null);
  let chatOpen = $state(false);

  $effect(() => {
    const t = track;
    const el = videoEl;
    if (!t || !el) return;
    t.attach(el);
    return () => {
      try { t.detach(el); } catch {}
    };
  });

  $effect(() => {
    const at = audioTrack;
    const el = audioEl;
    if (!at || !el) return;
    at.attach(el);
    el.play().catch(() => { /* autoplay best effort */ });
    return () => {
      try { at.detach(el); } catch {}
    };
  });
</script>

<div class="flex h-screen w-screen bg-black text-text-base">
  <div class="relative flex min-w-0 flex-1 flex-col">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      muted
      class="h-full w-full bg-black object-contain"
    ></video>

    {#if audioTrack}
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio bind:this={audioEl} autoplay style="display:none"></audio>
    {/if}

    <div class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm">
      <MonitorIcon class="size-3" />
      <span class="max-w-32 truncate">{name}</span>
    </div>

    <div class="absolute right-2 top-2 flex flex-col items-end gap-1.5">
      {#if streamerId}
        <button
          type="button"
          onclick={() => (chatOpen = !chatOpen)}
          class="flex items-center justify-center rounded-full p-1.5 text-white backdrop-blur-sm hover:bg-black/75 {chatOpen ? 'bg-primary/80' : 'bg-black/55'}"
          aria-label="Live-Chat"
          aria-pressed={chatOpen}
          title="Live-Chat"
        >
          <MessageSquareIcon class="size-3.5" />
        </button>
      {/if}
      <button
        type="button"
        onclick={onReattach}
        class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75"
        aria-label="Wieder in Pulse anzeigen"
        title="Wieder andocken"
      >
        <LogInIcon class="size-3.5" />
      </button>
    </div>
  </div>

  {#if chatOpen && streamerId}
    <StreamChatPanel {channelId} {streamerId} />
  {/if}
</div>
