<!--
  ScreenShareTile — playback of a remote LiveKit screen-share (Browser-Pfad).

  Chrome (HUD, Buttons, Fullscreen, Stats-Pille, Chat-Slots) liegt in
  `TileShell`. Hier nur: LiveKit-Track-Attach, Audio-Boost-Graph, Receive-
  Stats und Document-Picture-in-Picture (das ganze Tile in ein OS-Floating-
  Fenster mounten — selber JS-Context, Track bleibt direkt nutzbar).
-->
<script lang="ts">
  import { onMount, onDestroy, mount, unmount } from 'svelte';
  import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
  import { ReceiveStatsReader, type ReceiveStats } from '$lib/voice/screenShareStats';
  import { voice } from '$lib/voice/livekit.svelte';
  import { VolumeBoost } from '$lib/stream/volumeBoost';
  import StreamChatOverlay from '$lib/stream/components/StreamChatOverlay.svelte';
  import StreamChatInlineInput from '$lib/stream/components/StreamChatInlineInput.svelte';
  import StreamChatPanel from '$lib/stream/components/StreamChatPanel.svelte';
  import ScreenShareDocPipView from '$lib/stream/components/ScreenShareDocPipView.svelte';
  import TileShell from '$lib/stream/components/TileShell.svelte';
  import { getDocPip, docPipSupported, adoptDocStyles } from '$lib/stream/docpip';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { toast } from 'svelte-sonner';
  import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';

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

  // Twitch-style in-tile chat — TileShell rendert Panel/Overlay je nach
  // Fullscreen, hier nur der Toggle-State.
  let chatOpen = $state(false);

  let videoEl = $state<HTMLVideoElement | null>(null);
  let audioEl = $state<HTMLAudioElement | null>(null);
  let volume = $state(100);
  // Remembers last non-zero volume so the mute toggle can restore it.
  let prevVolume = 100;
  let localBlocked = $state(false);
  // Document-PiP: das ganze Tile wird in ein separates OS-Floating-Fenster
  // geMOUNTET. Selber JS-Context, Track bleibt direkt nutzbar.
  let isDocPip = $state(false);
  const docPipAvailable = docPipSupported();
  let pipWindow: Window | null = null;
  // Svelte 5 mount() liefert `Exports` — opakes Handle das unmount() frisst.
  let pipMount: Record<string, unknown> | null = null;
  const audioBlocked = $derived(localBlocked || voice.audioBlocked);
  // Lazy Web-Audio-Routing für >100%-Boost — `audioTrack.setVolume()` würde
  // sonst nur el.volume setzen, das HTML-spec-seitig auf 1.0 gecappt ist.
  let boost: VolumeBoost | null = null;

  // Stats-Overlay (codec/res/fps/bitrate) — 1 Hz über RemoteVideoTrack.
  let stats = $state<ReceiveStats | null>(null);
  const statsReader = new ReceiveStatsReader();
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  const errMsg = (e: unknown) => e instanceof Error ? `${e.name}: ${e.message}` : String(e);

  function applyVolume() {
    const v = volume / 100;
    if (audioEl && !audioEl.muted) audioEl.volume = Math.min(1.0, v);
    boost?.setVolume(v);
  }

  async function openDocPip(): Promise<void> {
    const api = getDocPip();
    if (!api) {
      const chrome = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '?';
      console.error('[docpip] documentPictureInPicture API missing on window. UA:', navigator.userAgent);
      toast.error(m.screen_share_tile_docpip_unavailable(), {
        description: m.screen_share_tile_docpip_unavailable_desc({ chrome }),
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
      const msg = errMsg(e);
      console.error('[docpip] requestWindow rejected:', e);
      toast.error(m.screen_share_tile_pip_open_failed(), {
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
        props: { track, audioTrack, streamerId, channelId, name, onReattach: reattachDocPip }
      });
      win.addEventListener('pagehide', reattachDocPip);
    } catch (e) {
      const msg = errMsg(e);
      console.error('[docpip] mount/adopt failed:', e);
      toast.error(m.screen_share_tile_pip_init_failed(), {
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
    const t = track;
    if (!t) {
      stats = null;
      return;
    }
    const cb = async () => {
      const next = await statsReader.read(t);
      if (next) stats = next;
    };
    void cb();
    statsTimer = setInterval(cb, 1000);
    return () => {
      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
    };
  });

  $effect(() => {
    const at = audioTrack;
    const el = audioEl;
    if (!at) {
      // Publisher dropped its audio track but keeps sharing video: tear down
      // the Web-Audio boost graph so its AudioContext doesn't sit open.
      boost?.dispose();
      boost = null;
      return;
    }
    if (!el) return;
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

  onDestroy(() => {
    // Tile demountet (Channel-Wechsel, Stream beendet) während ein PiP-Fenster
    // offen ist: erst Mount aufräumen, dann Fenster schließen.
    reattachDocPip();
    boost?.dispose();
    boost = null;
  });
</script>

{#if isDocPip}
  <div
    class="bg-bg-chat flex h-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-dashed border-border p-6 text-center"
    data-testid="screen-share-tile"
    data-identity={identity}
  >
    <div class="flex flex-col items-center gap-2" data-testid="screen-share-detached-placeholder">
      <ExternalLinkIcon class="text-text-muted size-10 opacity-50" />
      <p class="text-text-bright text-sm font-medium">{m.screen_share_tile_detached_label()}</p>
      <p class="text-text-muted text-xs">{name}</p>
      <Button size="xs" class="mt-1" onclick={reattachDocPip}>
        {m.screen_share_tile_reattach()}
      </Button>
    </div>
  </div>
{:else}
  {#snippet statsPill()}
    {#if stats}
      <div
        class="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] tabular-nums text-white backdrop-blur-sm"
        data-testid="screen-share-receive-stats"
        title={m.screen_share_tile_stats_tooltip({ codec: stats.codec, res: stats.res, fps: stats.fps, bitrate: stats.bitrate })}
      >
        <span>{stats.codec}</span>
        <span class="text-white/60">·</span>
        <span>{stats.res}</span>
        <span class="text-white/60">·</span>
        <span>{stats.fps}</span>
        <span class="text-white/60">·</span>
        <span>{stats.bitrate}</span>
      </div>
    {/if}
  {/snippet}

  <TileShell
    kind="screen"
    containerTestid="screen-share-tile"
    testidPrefix="screen-share"
    {identity}
    {name}
    video={videoEl}
    forceHud={audioBlocked}
    volume={audioTrack ? volume : undefined}
    onVolumeChange={handleVolume}
    onToggleMute={toggleMute}
    audioBlocked={!!audioTrack && audioBlocked}
    onEnableAudio={enableAudio}
    {chatOpen}
    onToggleChat={streamerId ? () => (chatOpen = !chatOpen) : undefined}
    onDetach={docPipAvailable ? () => void openDocPip() : undefined}
    onHide={() => openedTiles.close('screen', channelId, identity)}
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
      <!-- hidden audio element for screen-share audio track -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio bind:this={audioEl} autoplay style="display:none"></audio>
    {/snippet}
    {#snippet chatPanel()}
      {#if streamerId}
        <StreamChatPanel {channelId} {streamerId} onClose={() => (chatOpen = false)} />
      {/if}
    {/snippet}
    {#snippet chatOverlay()}
      {#if streamerId}
        <StreamChatOverlay {channelId} {streamerId} />
        <StreamChatInlineInput {channelId} {streamerId} />
      {/if}
    {/snippet}
  </TileShell>
{/if}
