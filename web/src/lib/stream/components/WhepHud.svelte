<!--
  WhepHud — sämtliche Overlays auf dem WhepPlayer-Video (Phase-Overlay,
  Streamer-Name, Stats, Volume-Bar, Buttons oben rechts). Extrahiert aus
  WhepPlayer.svelte damit die Connection-Component unter dem 250-Z.-Budget
  bleibt. Keine eigene Connection-Logik — alle dynamischen Werte als Props.
-->
<script lang="ts">
  import VolumeXIcon from '@lucide/svelte/icons/volume-x';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import MaximizeIcon from '@lucide/svelte/icons/maximize';
  import MinimizeIcon from '@lucide/svelte/icons/minimize';
  import LoaderIcon from '@lucide/svelte/icons/loader-circle';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import MessageSquareIcon from '@lucide/svelte/icons/message-square';
  import ClipboardIcon from '@lucide/svelte/icons/clipboard';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { formatDiagnostic, type StreamStats } from '../whep-stats';
  import { VOLUME_BOOST_MAX } from '../volumeBoost';

  let {
    phase,
    detail,
    name,
    stats,
    volume,
    audioBlocked,
    isFullscreen,
    chatOpen,
    onToggleFullscreen,
    onToggleChat,
    onToggleMute,
    onVolumeChange,
    onEnableAudio
  }: {
    phase: 'connecting' | 'playing' | 'retrying' | 'error';
    detail: string;
    name?: string;
    stats: StreamStats | null;
    volume: number;
    audioBlocked: boolean;
    isFullscreen: boolean;
    chatOpen: boolean;
    onToggleFullscreen: () => void;
    onToggleChat: () => void;
    onToggleMute: () => void;
    onVolumeChange: (e: Event) => void;
    onEnableAudio: () => void;
  } = $props();

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
</script>

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

{#if name}
  <div
    class="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur-sm"
    data-testid="hq-stream-streamer-name"
  >
    <RocketIcon class="size-3 text-red-400" />
    <span class="max-w-32 truncate">{name}</span>
  </div>
{/if}

{#if phase === 'playing' && stats}
  <div
    class="absolute left-2 top-2 flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] text-white backdrop-blur-sm {stats.frozen ? 'bg-red-700/80 animate-pulse' : 'bg-black/55'}"
    data-testid="hq-stream-stats"
    data-frozen={stats.frozen}
  >
    <span>{stats.res}</span><span>·</span><span>{stats.fps}</span><span>·</span><span>{stats.bitrate}</span>
    {#if stats.frozen}
      <span class="ml-1 font-sans font-semibold uppercase tracking-wide">freeze {stats.freezeSeconds.toFixed(0)}s</span>
    {/if}
    <button
      type="button"
      onclick={copyDiagnostic}
      class="ml-1 -mr-0.5 flex size-4 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
      aria-label="Stream-Diagnose in die Zwischenablage kopieren"
      title={copied ? 'Diagnose kopiert' : 'Diagnose kopieren'}
      data-testid="hq-stream-stats-copy"
    >
      {#if copied}<CheckIcon class="size-3" />{:else}<ClipboardIcon class="size-3" />{/if}
    </button>
  </div>
{/if}

<!-- Eine zusammenhängende Control-Reihe unten rechts: Volume-Pill (wenn playing),
     "Ton aktivieren" (wenn blocked), Chat-Toggle, Fullscreen-Toggle. -->
<div class="absolute bottom-2 right-2 flex items-center gap-1.5">
  {#if phase === 'playing'}
    <div class="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 backdrop-blur-sm">
      <button
        type="button"
        onclick={onToggleMute}
        class="flex items-center text-white hover:text-white/70"
        aria-label={volume === 0 ? 'Ton an' : 'Stummschalten'}
        data-testid="hq-stream-mute"
      >
        {#if volume === 0}<VolumeXIcon class="size-3" />{:else}<Volume2Icon class="size-3" />{/if}
      </button>
      <input
        type="range" min="0" max={VOLUME_BOOST_MAX} value={volume} oninput={onVolumeChange}
        class="w-24 accent-white sm:w-20"
        aria-label="Lautstärke des Streams"
        data-testid="hq-stream-volume"
      />
      <span
        class="w-9 text-right font-mono text-[11px] tabular-nums text-white/85"
        data-testid="hq-stream-volume-percent"
      >{volume}%</span>
    </div>
  {/if}
  {#if audioBlocked}
    <button
      type="button"
      onclick={onEnableAudio}
      class="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500"
      data-testid="hq-stream-unblock-audio"
    >
      <VolumeXIcon class="size-3" />
      Ton aktivieren
    </button>
  {/if}
  {#if isFullscreen}
    <!-- Chat-Toggle nur im Fullscreen: außerhalb gibts das Side-Panel daneben. -->
    <button
      type="button"
      onclick={onToggleChat}
      class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75 {chatOpen ? 'ring-2 ring-primary' : ''}"
      aria-label={chatOpen ? 'Live-Chat schließen' : 'Live-Chat öffnen'}
      aria-pressed={chatOpen}
      title={chatOpen ? 'Live-Chat schließen' : 'Live-Chat'}
      data-testid="hq-stream-chat-toggle"
    >
      <MessageSquareIcon class="size-3.5" />
    </button>
  {/if}
  <button
    type="button"
    onclick={onToggleFullscreen}
    class="flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white backdrop-blur-sm hover:bg-black/75"
    aria-label={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
    title={isFullscreen ? 'Vollbild verlassen' : 'Vollbild'}
    data-testid="hq-stream-fullscreen"
  >
    {#if isFullscreen}<MinimizeIcon class="size-3.5" />{:else}<MaximizeIcon class="size-3.5" />{/if}
  </button>
</div>
