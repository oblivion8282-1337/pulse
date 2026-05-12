<!--
  WhepPlayer — plays back a channel's HQ stream (GSR → MediaMTX) over WHEP (T4).

  Props: `{ channelId }` — the component fetches the WHEP URL itself via
  `chatApi.getWhepUrl(channelId)` (membership-gated chat-gateway proxy) and
  then runs the WHEP handshake (`$lib/stream/whep.ts`).

  Resilience:
  - If the WHEP POST 404s (publisher not online yet) or the network is down, we
    retry with backoff. Same when `pc.connectionState` goes `failed`.
  - On unmount / channel change we close the peer connection and best-effort
    DELETE the WHEP resource.

  Audio: a stream viewer wants to *hear* the stream, so the `<video>` is not
  muted. Browsers may still block autoplay-with-sound → a "click to enable"
  overlay (same idea as the LiveKit `audioBlocked` overlay in VoiceChannelView).
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
  import { chatApi } from '$lib/api/chat';
  import { connectWhep, WhepError, type WhepSession } from '../whep';
  import { WhepStatsReader, type StreamStats } from '../whep-stats';
  import { toggleFullscreen, isDocFullscreen } from '../fullscreen';

  let {
    channelId,
    userId,
    name
  }: { channelId: string; userId: string; name?: string } = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let volume = $state(100);
  // Remembers last non-zero volume so the mute toggle can restore it.
  let prevVolume = $state(100);
  let isFullscreen = $state(false);

  function handleToggleFullscreen() {
    toggleFullscreen(containerEl, videoEl);
  }

  function handleVolume(e: Event) {
    volume = Number((e.currentTarget as HTMLInputElement).value);
    if (volume > 0) prevVolume = volume;
    if (videoEl) videoEl.volume = volume / 100;
  }

  function toggleMute() {
    if (volume > 0) {
      prevVolume = volume;
      volume = 0;
    } else {
      volume = prevVolume > 0 ? prevVolume : 100;
    }
    if (videoEl) videoEl.volume = volume / 100;
  }

  let phase = $state<'connecting' | 'playing' | 'retrying' | 'error'>('connecting');
  let detail = $state<string>('');
  let audioBlocked = $state(false);
  let stats = $state<StreamStats | null>(null);

  // Retry backoff: publisher may not be online yet (404) or transient net loss.
  const RETRY_MS = [2000, 3000, 5000, 8000, 8000];
  let attempt = 0;
  let session: WhepSession | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  const statsReader = new WhepStatsReader();
  let disposed = false;
  // Track which channel the current run is for, so a late async result from a
  // previous channel doesn't clobber a newer connection.
  let runChannelId = '';

  function clearTimers() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  async function teardown() {
    clearTimers();
    const s = session;
    session = null;
    if (s) await s.close();
    if (videoEl) videoEl.srcObject = null;
  }

  function scheduleRetry() {
    if (disposed) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    phase = 'retrying';
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void start();
    }, wait);
  }

  async function start() {
    if (disposed) return;
    const cid = channelId;
    runChannelId = cid;
    await teardown();
    if (disposed || runChannelId !== cid) return;
    if (attempt === 0) phase = 'connecting';
    try {
      const { whep_url } = await chatApi.getWhepUrl(cid, userId);
      if (disposed || runChannelId !== cid) return;
      const s = await connectWhep(whep_url, (stream) => {
        if (videoEl) {
          videoEl.srcObject = stream;
          videoEl.volume = volume / 100;
        }
      });
      if (disposed || runChannelId !== cid) {
        await s.close();
        return;
      }
      session = s;
      attempt = 0;
      phase = 'playing';
      detail = '';
      s.pc.addEventListener('connectionstatechange', () => {
        if (disposed || session !== s) return;
        const st = s.pc.connectionState;
        if (st === 'failed' || st === 'disconnected' || st === 'closed') {
          void teardown().then(() => {
            if (!disposed && runChannelId === cid) scheduleRetry();
          });
        }
      });
      // Best-effort autoplay-with-sound; if blocked, show the overlay.
      statsReader.reset();
      void videoEl
        ?.play()
        .then(() => {
          audioBlocked = false;
        })
        .catch(() => {
          audioBlocked = true;
        });
      statsTimer = setInterval(async () => {
        const cur = session;
        if (cur) stats = await statsReader.read(cur.pc);
      }, 1000);
    } catch (e) {
      if (disposed || runChannelId !== cid) return;
      const status = e instanceof WhepError ? e.status : 0;
      detail = e instanceof Error ? e.message : String(e);
      // 404 = stream offline (publisher not up yet) → keep retrying quietly.
      if (status === 404 || status === 0 || status >= 500) {
        scheduleRetry();
      } else {
        phase = 'error';
      }
    }
  }

  async function enableAudio() {
    try {
      await videoEl?.play();
      audioBlocked = false;
    } catch {
      /* still blocked */
    }
  }

  // (Re)connect whenever the target channel changes. `start()` tears the
  // previous run down itself and `runChannelId` guards against a stale async
  // result from the old channel taking over.
  $effect(() => {
    const cid = channelId;
    if (!cid) return;
    attempt = 0;
    void start();
  });

  onMount(() => {
    function onFsChange() {
      isFullscreen = isDocFullscreen();
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  });

  onDestroy(() => {
    disposed = true;
    void teardown();
  });
</script>

<div
  bind:this={containerEl}
  class="bg-bg-chat relative flex h-full flex-col overflow-hidden rounded-2xl border border-border"
  data-testid="hq-stream-player"
  data-channel-id={channelId}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <video
    bind:this={videoEl}
    autoplay
    playsinline
    class="h-full w-full cursor-pointer bg-black object-contain"
    onclick={handleToggleFullscreen}
    title="Klicken für Vollbild / Esc zum Verlassen"
  ></video>

  {#if phase === 'connecting' || phase === 'retrying'}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-white">
      <LoaderIcon class="size-7 animate-spin" />
      <p class="text-sm">{phase === 'retrying' ? 'Warte auf den Stream…' : 'Verbinde mit dem Stream…'}</p>
      {#if detail && phase === 'retrying'}
        <p class="max-w-sm text-center text-[11px] text-white/60">{detail}</p>
      {/if}
    </div>
  {:else if phase === 'error'}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 text-red-200">
      <AlertTriangleIcon class="size-7" />
      <p class="text-sm">Stream konnte nicht geladen werden</p>
      {#if detail}<p class="max-w-sm text-center text-[11px] text-red-200/70">{detail}</p>{/if}
    </div>
  {/if}

  <!--
    Top-right corner: Maximize button always visible, "Ton aktivieren" below it
    when audioBlocked. Stacking them vertically avoids overlap — both remain
    individually tappable on touch screens.
  -->
  <div class="absolute right-2 top-2 flex flex-col items-end gap-1.5">
    <button
      type="button"
      onclick={handleToggleFullscreen}
      class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75"
      aria-label={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
      title={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
      data-testid="hq-stream-fullscreen"
    >
      {#if isFullscreen}
        <MinimizeIcon class="size-3.5" />
      {:else}
        <MaximizeIcon class="size-3.5" />
      {/if}
    </button>

    {#if audioBlocked}
      <button
        type="button"
        onclick={enableAudio}
        class="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500"
        data-testid="hq-stream-unblock-audio"
      >
        <VolumeXIcon class="size-3" />
        Ton aktivieren
      </button>
    {/if}
  </div>

  {#if name}
    <div
      class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
      data-testid="hq-stream-streamer-name"
    >
      <RadioTowerIcon class="size-3 text-red-400" />
      <span class="max-w-32 truncate">{name}</span>
    </div>
  {/if}

  {#if phase === 'playing'}
    <div class="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur-sm">
      <button
        type="button"
        onclick={toggleMute}
        class="flex items-center text-white hover:text-white/70"
        aria-label={volume === 0 ? 'Ton an' : 'Stummschalten'}
        data-testid="hq-stream-mute"
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
        aria-label="Lautstärke des Streams"
        data-testid="hq-stream-volume"
      />
    </div>
  {/if}

  {#if phase === 'playing' && stats}
    <div
      class="absolute left-2 top-2 flex items-center gap-2 rounded-full bg-black/55 px-2.5 py-1 font-mono text-[11px] text-white backdrop-blur-sm"
      data-testid="hq-stream-stats"
    >
      <span>{stats.res}</span><span>·</span><span>{stats.fps}</span><span>·</span><span>{stats.bitrate}</span>
    </div>
  {/if}
</div>
