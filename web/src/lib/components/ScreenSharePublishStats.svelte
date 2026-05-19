<!--
  Kleine Status-Pille für den Streamenden — zeigt während des eigenen
  Bildschirm-Teilens an, was tatsächlich rausgeht:
    [GPU] H.264 · 1920×1080 · 30 fps · 4.0 Mbit/s

  Pollt sekündlich `voice.localScreenShareTrack.getRTCStatsReport()`. Solange
  WebRTC die outbound-rtp-Reports noch nicht gefüllt hat (typischerweise das
  erste 1–2 s nach Start), zeigt sie "—" — bewusst nicht versteckt, damit der
  Streamer den Start des Streams optisch bestätigt sieht.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { LocalVideoTrack } from 'livekit-client';
  import CpuIcon from '@lucide/svelte/icons/cpu';
  import ZapIcon from '@lucide/svelte/icons/zap';
  import HelpCircleIcon from '@lucide/svelte/icons/help-circle';
  import { voice } from '$lib/voice/livekit.svelte';
  import { PublishStatsReader, type PublishStats } from '$lib/voice/screenShareStats';

  let stats = $state<PublishStats | null>(null);
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
    // Nur poller laufen lassen, solange wir tatsächlich teilen.
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

  // Kompakter Hinweis als Tooltip — der rohe `encoderImplementation`-String
  // ist für Bug-Reports nützlich (z.B. "OpenH264" vs "MediaFoundation_h264")
  // und sonst nirgends sichtbar.
  let tooltip = $derived.by(() => {
    if (!stats) return 'Encoder-Stats werden gleich verfügbar …';
    const lines = [
      `Codec: ${stats.codec}`,
      `Auflösung: ${stats.res}`,
      `Framerate: ${stats.fps}`,
      `Bitrate: ${stats.bitrate}`,
      `Encoder: ${stats.encoderImpl || '—'}`,
      stats.encoderKind === 'gpu'
        ? 'Hardware-beschleunigt (GPU)'
        : stats.encoderKind === 'cpu'
          ? 'Software-Encode (CPU)'
          : 'Encoder-Typ unbekannt'
    ];
    return lines.join('\n');
  });
</script>

{#if voice.isScreenSharing}
  <div
    class="bg-bg-soft border-border-soft text-text-base flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] tabular-nums"
    title={tooltip}
    data-testid="screen-share-publish-stats"
  >
    {#if stats?.encoderKind === 'gpu'}
      <span class="flex items-center gap-1 text-emerald-400" data-testid="encoder-kind-gpu">
        <ZapIcon class="size-3" />
        GPU
      </span>
    {:else if stats?.encoderKind === 'cpu'}
      <span class="flex items-center gap-1 text-amber-400" data-testid="encoder-kind-cpu">
        <CpuIcon class="size-3" />
        CPU
      </span>
    {:else}
      <span class="text-text-muted flex items-center gap-1" data-testid="encoder-kind-unknown">
        <HelpCircleIcon class="size-3" />
        ?
      </span>
    {/if}
    <span class="text-text-muted">·</span>
    <span>{stats?.codec ?? '—'}</span>
    <span class="text-text-muted">·</span>
    <span>{stats?.res ?? '—'}</span>
    <span class="text-text-muted">·</span>
    <span>{stats?.fps ?? '—'}</span>
    <span class="text-text-muted">·</span>
    <span>{stats?.bitrate ?? '—'}</span>
  </div>
{/if}
