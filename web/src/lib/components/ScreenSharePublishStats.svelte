<!--
  Encoder-Badge für den Streamenden — kleines GPU/CPU-Indicator-Icon, das als
  absolutes Overlay auf dem ScreenShare-Button gelegt wird. Die Details
  (Codec/Auflösung/FPS/Bitrate/encoderImplementation) fließen über `bind:stats`
  zurück zum Parent, der sie in den Button-Tooltip einbettet — damit die Info
  nicht in der schmalen VoiceControlBar truncated wird.

  Pollt sekündlich `voice.localScreenShareTrack.getRTCStatsReport()`. Solange
  WebRTC die outbound-rtp-Reports noch nicht gefüllt hat (typischerweise die
  ersten 1–2 s nach Start), bleibt das Badge im "?"-Zustand sichtbar — damit
  der Streamer den Start optisch bestätigt sieht.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { LocalVideoTrack } from 'livekit-client';
  import CpuIcon from '@lucide/svelte/icons/cpu';
  import ZapIcon from '@lucide/svelte/icons/zap';
  import HelpCircleIcon from '@lucide/svelte/icons/help-circle';
  import { voice } from '$lib/voice/livekit.svelte';
  import { PublishStatsReader, type PublishStats } from '$lib/voice/screenShareStats';

  let { stats = $bindable<PublishStats | null>(null) } = $props();

  let reader = new PublishStatsReader();
  let timer: ReturnType<typeof setInterval> | null = null;
  // Letzter Track, gegen den der Reader läuft — bei Wechsel (Re-Start nach
  // Codec/Resolution-Toggle) wird der Reader zurückgesetzt damit die
  // Bitrate-Delta-Berechnung nicht auf alten Werten beruht.
  let trackRef: LocalVideoTrack | null = null;

  async function tick() {
    const track = voice.localScreenShareTrack;
    if (track !== trackRef) {
      reader.reset();
      trackRef = track;
    }
    if (!track) {
      stats = null;
      return;
    }
    const next = await reader.read(track);
    if (next) stats = next;
  }

  $effect(() => {
    if (!voice.isScreenSharing) {
      stats = null;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      reader.reset();
      trackRef = null;
      return;
    }
    if (!timer) {
      void tick();
      timer = setInterval(() => void tick(), 1000);
    }
  });

  onDestroy(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
</script>

{#if voice.isScreenSharing}
  <span
    class="bg-bg-base ring-border absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full ring-1"
    data-testid="screen-share-publish-stats"
    aria-hidden="true"
  >
    {#if stats?.encoderKind === 'gpu'}
      <ZapIcon class="size-2.5 text-emerald-400" data-testid="encoder-kind-gpu" />
    {:else if stats?.encoderKind === 'cpu'}
      <CpuIcon class="size-2.5 text-amber-400" data-testid="encoder-kind-cpu" />
    {:else}
      <HelpCircleIcon class="text-text-muted size-2.5" data-testid="encoder-kind-unknown" />
    {/if}
  </span>
{/if}
