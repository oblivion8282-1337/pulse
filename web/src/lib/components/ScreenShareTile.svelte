<script lang="ts">
  import { onMount, onDestroy, mount, unmount } from 'svelte';
  import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import { voice } from '$lib/voice/livekit.svelte';
  import { toggleFullscreen, isDocFullscreen } from '$lib/stream/fullscreen';
  import { VolumeBoost, VOLUME_BOOST_MAX } from '$lib/stream/volumeBoost';
  import StreamChatOverlay from '$lib/stream/components/StreamChatOverlay.svelte';
  import StreamChatInlineInput from '$lib/stream/components/StreamChatInlineInput.svelte';
  import StreamChatPanel from '$lib/stream/components/StreamChatPanel.svelte';
  import ScreenShareDocPipView from '$lib/stream/components/ScreenShareDocPipView.svelte';
  import { getDocPip, docPipSupported, adoptDocStyles } from '$lib/stream/docpip';
  import { toast } from 'svelte-sonner';

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
  // Document-PiP: das ganze Tile (Video + Chat + Reattach-Button) wird in ein
  // separates OS-Floating-Fenster geMOUNTET. Selber JS-Context, Track bleibt
  // direkt nutzbar.
  let isDocPip = $state(false);
  const docPipAvailable = docPipSupported();
  let pipWindow: Window | null = null;
  // Svelte 5 mount() liefert `Exports` — generic Record-Typ, intern für uns
  // ein opakes Handle das unmount() später wieder frisst.
  let pipMount: Record<string, unknown> | null = null;
  const audioBlocked = $derived(localBlocked || voice.audioBlocked);
  // Lazy Web-Audio-Routing für >100%-Boost — `audioTrack.setVolume()` würde
  // sonst nur el.volume setzen, das HTML-spec-seitig auf 1.0 gecappt ist.
  let boost: VolumeBoost | null = null;

  function applyVolume() {
    const v = volume / 100;
    if (audioEl && !audioEl.muted) audioEl.volume = Math.min(1.0, v);
    boost?.setVolume(v);
  }

  function handleToggleFullscreen() {
    toggleFullscreen(containerEl, videoEl);
  }

  async function openDocPip(): Promise<void> {
    const api = getDocPip();
    if (!api) {
      const chrome = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '?';
      console.error('[docpip] documentPictureInPicture API missing on window. UA:', navigator.userAgent);
      toast.error('Document-Picture-in-Picture nicht verfügbar', {
        description: `${chrome} — die API ist in diesem Build deaktiviert. Bitte Electron neu bauen (cd desktop && pnpm run build:electron).`,
        duration: 60000,
        closeButton: true
      });
      return;
    }
    let win: Window;
    try {
      win = await api.requestWindow({
        width: Math.min(1100, Math.round(window.screen.availWidth * 0.55)),
        height: Math.min(680, Math.round(window.screen.availHeight * 0.65))
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error('[docpip] requestWindow rejected:', e);
      toast.error('Stream-Fenster ließ sich nicht öffnen', {
        description: msg,
        duration: 60000,
        closeButton: true
      });
      return;
    }
    try {
      adoptDocStyles(document, win.document);
      // Erst State umschalten — das unmounted das Tile-Video, $effect-Cleanup
      // detached die Track. Danach `mount()` im PiP-Document = saubere
      // Single-Attach-Sequenz, kein Stream-Doppel-Subscribe.
      isDocPip = true;
      pipWindow = win;
      pipMount = mount(ScreenShareDocPipView, {
        target: win.document.body,
        props: {
          track,
          audioTrack,
          streamerId,
          channelId,
          name,
          onReattach: reattachDocPip
        }
      });
      win.addEventListener('pagehide', reattachDocPip);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error('[docpip] mount/adopt failed:', e);
      toast.error('Stream-Fenster ließ sich nicht initialisieren', {
        description: msg,
        duration: 60000,
        closeButton: true
      });
      try { win.close(); } catch {}
      isDocPip = false;
      pipWindow = null;
    }
  }

  function reattachDocPip(): void {
    if (pipMount) {
      try { unmount(pipMount); } catch {}
      pipMount = null;
    }
    if (pipWindow && !pipWindow.closed) {
      try { pipWindow.close(); } catch {}
    }
    pipWindow = null;
    isDocPip = false;
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
    if (!boost) {
      boost = new VolumeBoost();
      boost.onStateChange = (s) => { localBlocked = s; };
    }
    // Audio doppelt-spielt sonst (einmal via Element, einmal via AudioContext).
    // Klappt das Boost-Attach nicht, unmuten — Slider operiert dann auf
    // el.volume (≤100%).
    const mst = at.mediaStreamTrack;
    const boosted = mst ? boost.attach(new MediaStream([mst])) : false;
    el.muted = boosted;
    applyVolume();
    localBlocked = boosted && boost.suspended;
    el.play().catch(() => { /* autoplay best effort */ });
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
      await boost?.resume();
      localBlocked = !!boost?.suspended;
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
    // Falls das Tile demountet wird (Channel-Wechsel, Stream beendet) während
    // ein PiP-Fenster offen ist: erst den Mount aufräumen, dann das Fenster
    // schließen — sonst überlebt das Popup ohne Source.
    reattachDocPip();
    boost?.dispose();
    boost = null;
  });
</script>

<div
  bind:this={containerEl}
  class="bg-bg-chat flex h-full overflow-hidden rounded-2xl border border-border"
  data-testid="screen-share-tile"
  data-identity={identity}
>
  {#if isDocPip}
    <div
      class="flex h-full w-full flex-col items-center justify-center gap-2 border border-dashed border-border bg-bg-chat p-6 text-center"
      data-testid="screen-share-detached-placeholder"
    >
      <ExternalLinkIcon class="text-text-muted size-10 opacity-50" />
      <p class="text-text-bright text-sm font-medium">Stream in eigenem Fenster</p>
      <p class="text-text-muted text-xs">{name}</p>
      <button
        type="button"
        onclick={reattachDocPip}
        class="bg-primary hover:bg-primary/90 mt-1 rounded-full px-3 py-1 text-xs font-semibold text-white"
      >Wieder andocken</button>
    </div>
  {:else}
  <div class="relative flex min-w-0 flex-1 flex-col">
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

  {#if isFullscreen && chatOpen && streamerId}
    <StreamChatOverlay {channelId} {streamerId} />
    <StreamChatInlineInput {channelId} {streamerId} />
  {/if}

  <!-- Zusammenhängende Control-Reihe unten rechts — gleiche Anordnung wie
       beim WhepPlayer-HUD: Volume-Pill, "Ton aktivieren", Chat-Toggle,
       Detach, Fullscreen-Toggle. -->
  <div class="absolute bottom-2 right-2 flex items-center gap-1.5">
    {#if audioTrack}
      <div class="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur-sm">
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
          data-testid="screen-share-volume"
        />
        <span
          class="w-9 text-right font-mono text-[11px] tabular-nums text-white/85"
          data-testid="screen-share-volume-percent"
        >{volume}%</span>
      </div>
    {/if}
    {#if audioTrack && audioBlocked}
      <button
        type="button"
        onclick={enableAudio}
        class="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500"
        data-testid="screen-share-unblock-audio"
      >
        <VolumeXIcon class="size-3" />
        Ton aktivieren
      </button>
    {/if}
    {#if streamerId}
      <button
        type="button"
        onclick={() => (chatOpen = !chatOpen)}
        class="flex items-center justify-center rounded-full p-1.5 text-white backdrop-blur-sm hover:bg-black/75 {chatOpen ? 'ring-2 ring-primary bg-black/55' : 'bg-black/55'}"
        aria-label={chatOpen ? 'Live-Chat schließen' : 'Live-Chat öffnen'}
        aria-pressed={chatOpen}
        title={chatOpen ? 'Live-Chat schließen' : 'Live-Chat'}
        data-testid="screen-share-chat-toggle"
      >
        <MessageSquareIcon class="size-3.5" />
      </button>
    {/if}
    {#if docPipAvailable && !isFullscreen}
      <button
        type="button"
        onclick={() => void openDocPip()}
        class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75"
        aria-label="Stream in eigenem Fenster"
        title="In eigenem Fenster öffnen"
        data-testid="screen-share-detach"
      >
        <ExternalLinkIcon class="size-3.5" />
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
  </div>
  </div>

  {#if chatOpen && !isFullscreen && streamerId}
    <StreamChatPanel {channelId} {streamerId} />
  {/if}
  {/if}
</div>
