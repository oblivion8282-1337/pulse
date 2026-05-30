<!--
  WhepPlayer — plays back a channel's HQ stream (GSR → MediaMTX) over WHEP (T4).

  Props: `{ channelId, userId }` — the component fetches the WHEP URL itself via
  `chatApi.getWhepUrl(channelId)` (membership-gated chat-gateway proxy) and
  then runs the WHEP handshake (`$lib/stream/whep.ts`).

  Resilience:
  - If the WHEP POST 404s (publisher not online yet) or the network is down, we
    retry with backoff. Same when `pc.connectionState` goes `failed`.
  - On unmount / channel change we close the peer connection and best-effort
    DELETE the WHEP resource.

  Audio: a stream viewer wants to *hear* the stream, so the `<video>` is not
  muted. Browsers may still block autoplay-with-sound → `audioBlocked`.

  Die gesamte Chrome (HUD, Buttons, Fullscreen, Stats-Pille, Chat-Slots) liegt
  in `TileShell` — diese Component hält nur noch WHEP-Verbindung + Audio-Graph.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { chatApi } from '$lib/api/chat';
  import { connectWhep, WhepError, type WhepSession } from '../whep';
  import { WhepStatsReader, formatDiagnostic, type StreamStats } from '../whep-stats';
  import { VolumeBoost } from '../volumeBoost';
  import StreamChatOverlay from './StreamChatOverlay.svelte';
  import StreamChatInlineInput from './StreamChatInlineInput.svelte';
  import StreamChatPanel from './StreamChatPanel.svelte';
  import TileShell from './TileShell.svelte';
  import { detachedStreams } from '../detach.svelte';
  import { openedTiles } from '../openedTiles.svelte';
  import { toast } from 'svelte-sonner';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';

  let {
    channelId,
    userId,
    name,
    canDetach = true,
    canHide = true,
    compact = false,
    focused = false,
    onToggleFocus
  }: {
    channelId: string;
    userId: string;
    name?: string;
    /** Wenn false, kein Detach-Button — z.B. im bereits entkoppelten Popup. */
    canDetach?: boolean;
    /** Wenn false, kein Hide-Button — im Popup-Fenster sinnlos. */
    canHide?: boolean;
    /** Filmstrip-Kachel im Fokus-Modus. */
    compact?: boolean;
    /** Diese Kachel ist die fokussierte (große). */
    focused?: boolean;
    onToggleFocus?: () => void;
  } = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let volume = $state(100);
  // Remembers last non-zero volume so the mute toggle can restore it.
  let prevVolume = $state(100);
  let chatOpen = $state(false);

  function handleDetach(): void {
    const opened = detachedStreams.open(channelId, userId);
    if (!opened) {
      toast.error(m.whep_player_popup_blocked(), {
        description: m.whep_player_popup_blocked_description()
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

  // Stats-Diagnose in die Zwischenablage (Button in der Stats-Pille).
  let copied = $state(false);
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  async function copyDiagnostic() {
    if (!stats) return;
    try {
      await navigator.clipboard.writeText(formatDiagnostic(stats.diagnostic, { name }));
      copied = true;
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copied = false;
        copyResetTimer = null;
      }, 1500);
    } catch {
      /* clipboard API kann in non-secure-Contexts failen — silent */
    }
  }

  // Retry backoff: publisher may not be online yet (404) or transient net loss.
  const RETRY_MS = [1000, 2000, 3000, 5000, 5000];
  let attempt = 0;
  let session: WhepSession | null = null;
  // Active connectionstatechange listener for the current session — held so
  // teardown can remove it. Without removal each retry would attach a fresh
  // closure to the previous (closed) RTCPeerConnection.
  let connListener: ((this: RTCPeerConnection, ev: Event) => void) | null = null;
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
    if (s && connListener) {
      s.pc.removeEventListener('connectionstatechange', connListener);
    }
    connListener = null;
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
      connListener = () => {
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
      };
      s.pc.addEventListener('connectionstatechange', connListener);
      // Video ist muted, also autoplay-tauglich; der Audio-Block hängt jetzt
      // am AudioContext (kann suspended sein bevor der User klickt).
      statsReader.reset();
      void videoEl?.play().catch(() => {
        /* muted media should autoplay */
      });
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
    boost.onStateChange = (suspended) => {
      audioBlocked = suspended;
    };
  });

  onDestroy(() => {
    disposed = true;
    void teardown();
    boost?.dispose();
    if (copyResetTimer) clearTimeout(copyResetTimer);
  });
</script>

<!-- Stats-Pille: Codec/FPS/Bitrate + Freeze/Stutter-Warnung. Positionierung
     übernimmt TileShell, hier nur der Pillen-Inhalt. -->
{#snippet statsPill()}
  {#if phase === 'playing' && stats}
    <div
      class="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] text-white backdrop-blur-sm {stats.frozen
        ? 'animate-pulse bg-red-700/80'
        : 'bg-black/55'}"
      data-testid="hq-stream-stats"
      data-frozen={stats.frozen}
    >
      <span>{stats.res}</span><span>·</span><span>{stats.fps}</span><span>·</span><span
        >{stats.bitrate}</span
      ><span>·</span><span>{stats.codec}</span>
      {#if stats.frozen}
        <span class="ml-1 font-sans font-semibold uppercase tracking-wide"
          >freeze {stats.freezeSeconds.toFixed(0)}s</span
        >
      {:else if stats.microStutters > 0}
        <span
          class="ml-1 font-sans text-amber-300"
          title={m.whep_player_microstutter_title()}
        >⚠ {stats.microStutters}</span>
      {/if}
      <button
        type="button"
        onclick={copyDiagnostic}
        class="ml-1 -mr-0.5 flex size-4 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        aria-label={m.whep_player_copy_diagnostic_aria()}
        title={copied ? m.whep_player_diagnostic_copied() : m.whep_player_copy_diagnostic()}
        data-testid="hq-stream-stats-copy"
      >
        {#if copied}<CheckIcon class="size-3" />{:else}<ClipboardIcon class="size-3" />{/if}
      </button>
    </div>
  {/if}
{/snippet}

<TileShell
  kind="hq"
  containerTestid="hq-stream-player"
  testidPrefix="hq-stream"
  name={name ?? 'Stream'}
  nameTestid="hq-stream-streamer-name"
  video={videoEl}
  forceHud={audioBlocked}
  {volume}
  onVolumeChange={handleVolume}
  onToggleMute={toggleMute}
  {audioBlocked}
  onEnableAudio={enableAudio}
  {chatOpen}
  onToggleChat={() => (chatOpen = !chatOpen)}
  onDetach={canDetach ? handleDetach : undefined}
  onHide={canHide ? () => openedTiles.close('hq', channelId, userId) : undefined}
  {compact}
  {focused}
  {onToggleFocus}
  stats={statsPill}
>
  {#snippet media()}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      class="h-full w-full bg-black object-contain"
    ></video>
  {/snippet}
  {#snippet overlay()}
    {#if phase === 'connecting' || phase === 'retrying'}
      <div
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-white"
      >
        <LoaderIcon class="size-7 animate-spin" />
        <p class="text-sm">
          {phase === 'retrying' ? m.whep_player_waiting_for_stream() : m.whep_player_connecting_to_stream()}
        </p>
        {#if detail && phase === 'retrying'}
          <p class="max-w-sm text-center text-[11px] text-white/60">{detail}</p>
        {/if}
      </div>
    {:else if phase === 'error'}
      <div
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 text-red-200"
      >
        <AlertTriangleIcon class="size-7" />
        <p class="text-sm">{m.whep_player_stream_load_failed()}</p>
        {#if detail}<p class="max-w-sm text-center text-[11px] text-red-200/70">{detail}</p>{/if}
      </div>
    {/if}
  {/snippet}
  {#snippet chatPanel()}
    <StreamChatPanel {channelId} streamerId={userId} onClose={() => (chatOpen = false)} />
  {/snippet}
  {#snippet chatOverlay()}
    <StreamChatOverlay {channelId} streamerId={userId} />
    <StreamChatInlineInput {channelId} streamerId={userId} />
  {/snippet}
</TileShell>
