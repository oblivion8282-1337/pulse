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
  import { chatApi } from '$lib/api/chat';
  import { connectWhep, WhepError, type WhepSession } from '../whep';
  import { WhepStatsReader, type StreamStats } from '../whep-stats';
  import { toggleFullscreen, isDocFullscreen } from '../fullscreen';
  import { VolumeBoost } from '../volumeBoost';
  import StreamChatOverlay from './StreamChatOverlay.svelte';
  import StreamChatInlineInput from './StreamChatInlineInput.svelte';
  import StreamChatPanel from './StreamChatPanel.svelte';
  import WhepHud from './WhepHud.svelte';
  import { detachedStreams } from '../detach.svelte';
  import { hiddenTiles } from '../hiddenTiles.svelte';
  import { toast } from 'svelte-sonner';
  import XIcon from '@lucide/svelte/icons/x';

  let {
    channelId,
    userId,
    name,
    canDetach = true,
    canHide = true
  }: {
    channelId: string;
    userId: string;
    name?: string;
    /** Wenn false, kein Detach-Button im HUD — z.B. im bereits entkoppelten
     *  Popup-Fenster wäre ein weiteres Detach sinnlos. */
    canDetach?: boolean;
    /** Wenn false, kein lokaler Hide-Button — im Popup-Fenster sinnlos. */
    canHide?: boolean;
  } = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let volume = $state(100);
  // Remembers last non-zero volume so the mute toggle can restore it.
  let prevVolume = $state(100);
  let isFullscreen = $state(false);
  // Inline-Side-Chat (außerhalb Fullscreen) / Twitch-Style-Overlay (im Fullscreen).
  let chatOpen = $state(false);

  function handleDetach(): void {
    const opened = detachedStreams.open(channelId, userId);
    if (!opened) {
      toast.error('Popup blockiert', {
        description: 'Bitte erlaube Pop-up-Fenster für Pulse und versuche es erneut.'
      });
    }
  }
  let boost: VolumeBoost | null = null;
  function applyVolume() {
    const v = volume / 100;
    // Boost-Graph aktiv → Element ist muted, gain regelt. Fallback → unmuted,
    // el.volume regelt (auf [0, 1] geclampt — >100% gibt's da nicht).
    if (videoEl && !videoEl.muted) videoEl.volume = Math.min(1.0, v);
    boost?.setVolume(v);
  }

  // Twitch-Style HUD-Auto-Hide: nach ~2.5s ohne Maus-/Touch-Aktivität fadet
  // Stats/Name/Control-Reihe weg. WhepHud erzwingt selbst Sichtbarkeit
  // solange audioBlocked oder stats.frozen — Bubbles + Inline-Input sind
  // außerhalb der HUD-Group und faden unabhängig.
  let hudVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const HUD_HIDE_AFTER_MS = 2500;
  function pokeHud() {
    hudVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hudVisible = false; }, HUD_HIDE_AFTER_MS);
  }

  function handleToggleFullscreen() {
    toggleFullscreen(containerEl, videoEl);
  }

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

  let phase = $state<'connecting' | 'playing' | 'retrying' | 'error'>('connecting');
  let detail = $state<string>('');
  let audioBlocked = $state(false);
  let stats = $state<StreamStats | null>(null);

  // Retry backoff: publisher may not be online yet (404) or transient net loss.
  const RETRY_MS = [1000, 2000, 3000, 5000, 5000];
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
        if (!videoEl) return;
        videoEl.srcObject = stream;
        // Audio kommt aus dem Web-Audio-Graph (createMediaStreamSource), sonst
        // doppelt. createMediaElementSource funktioniert mit srcObject=MediaStream
        // nicht zuverlässig (Chromium). Klappt das nicht (kein Audio-Track,
        // kein AudioContext), unmuten und Slider operiert auf el.volume (≤100%).
        if (boost?.attach(stream)) {
          videoEl.muted = true;
          applyVolume();
          audioBlocked = boost.suspended;
        } else {
          videoEl.muted = false;
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
        // `disconnected` is transient — Chromium recovers it back to `connected`
        // most of the time. Only retry on the definitive states; otherwise we
        // tear down every micro-glitch on the UDP path and loop for ~18s.
        if (st === 'failed' || st === 'closed') {
          void teardown().then(() => {
            if (!disposed && runChannelId === cid) scheduleRetry();
          });
        }
      });
      // Video ist muted, also autoplay-tauglich; der Audio-Block hängt jetzt
      // am AudioContext (kann suspended sein bevor der User klickt).
      statsReader.reset();
      void videoEl?.play().catch(() => { /* muted media should autoplay */ });
      audioBlocked = !!boost?.suspended;
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
      await boost?.resume();
      audioBlocked = !!boost?.suspended;
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
    boost = new VolumeBoost();
    boost.onStateChange = (suspended) => { audioBlocked = suspended; };
    pokeHud();
    function onFsChange() {
      isFullscreen = isDocFullscreen();
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  });

  onDestroy(() => {
    disposed = true;
    void teardown();
    boost?.dispose();
    if (hideTimer) clearTimeout(hideTimer);
  });
</script>

<div
  bind:this={containerEl}
  class="bg-bg-chat flex h-full overflow-hidden rounded-2xl border border-border"
  data-testid="hq-stream-player"
  data-channel-id={channelId}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div
    class="relative flex min-w-0 flex-1 flex-col"
    onmousemove={pokeHud}
    ontouchstart={pokeHud}
    role="presentation"
  >
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      class="h-full w-full cursor-pointer bg-black object-contain"
      onclick={handleToggleFullscreen}
      title="Klicken für Vollbild / Esc zum Verlassen"
    ></video>

    {#if canHide}
      <button
        type="button"
        onclick={() => hiddenTiles.hide('hq', channelId, userId)}
        class="absolute right-2 top-2 z-10 flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-red-600"
        aria-label="Stream ausblenden"
        title="Diesen Stream ausblenden"
        data-testid="hq-stream-hide"
      >
        <XIcon class="size-3.5" />
      </button>
    {/if}

    <WhepHud
      {phase}
      {detail}
      {name}
      {stats}
      {volume}
      {audioBlocked}
      {isFullscreen}
      {chatOpen}
      visible={hudVisible}
      onToggleFullscreen={handleToggleFullscreen}
      onToggleChat={() => (chatOpen = !chatOpen)}
      onToggleMute={toggleMute}
      onVolumeChange={handleVolume}
      onEnableAudio={enableAudio}
      onDetach={canDetach ? handleDetach : undefined}
    />

    {#if isFullscreen && chatOpen}
      <StreamChatOverlay {channelId} streamerId={userId} />
      <StreamChatInlineInput {channelId} streamerId={userId} />
    {/if}
  </div>

  {#if chatOpen && !isFullscreen}
    <StreamChatPanel {channelId} streamerId={userId} />
  {/if}
</div>
