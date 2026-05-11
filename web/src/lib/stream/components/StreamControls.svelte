<!--
  StreamControls — der Start/Stop-Button + Live-Status-Block.

  Liest `stream` aus `state.svelte.ts` (running, state, fps, uptimeS, error).
  Beim Start: ruft `gsr.start(buildStartArgs())`. Stop: `gsr.stop()`.
  Disable wenn Bridge nicht verfügbar.

  Uptime-Anzeige: Wir rechnen `mm:ss` selbst aus `stream.uptimeS`. Der
  Sidecar feuert FPS-Events nur alle ~1 s, also reicht das als Trigger für
  re-render — kein eigener Timer nötig.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import PlayIcon from '@lucide/svelte/icons/play';
  import SquareIcon from '@lucide/svelte/icons/square';
  import CircleIcon from '@lucide/svelte/icons/circle';
  import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
  import { gsr } from '../gsr';
  import { stream } from '../state.svelte';
  import { buildStartArgs, streamSettings } from '../settings.svelte';

  let busy = $state(false);
  let localError = $state<string | null>(null);

  let bridgeReady = $derived(gsr.available() && stream.available);
  let canStart = $derived(
    bridgeReady &&
      !stream.running &&
      !busy &&
      !!streamSettings.profile_name &&
      !!streamSettings.server_name,
  );
  let canStop = $derived(bridgeReady && stream.running && !busy);

  function formatUptime(s: number | null): string {
    if (s == null || s < 0) return '00:00';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  let uptimeLabel = $derived(formatUptime(stream.uptimeS));
  let stateLabel = $derived.by(() => {
    switch (stream.state) {
      case 'starting':
        return 'Connecting…';
      case 'live':
        return 'Live';
      case 'error':
        return 'Fehler';
      case 'stopped':
        return 'Gestoppt';
      default:
        return 'Idle';
    }
  });
  let stateColor = $derived.by(() => {
    switch (stream.state) {
      case 'starting':
        return 'text-amber-400';
      case 'live':
        return 'text-emerald-400';
      case 'error':
        return 'text-red-400';
      default:
        return 'text-text-muted';
    }
  });

  async function onStart() {
    busy = true;
    localError = null;
    try {
      const r = await gsr.start(buildStartArgs());
      if (r && !r.ok) localError = r.error ?? 'Start fehlgeschlagen.';
    } catch (e) {
      localError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function onStop() {
    busy = true;
    try {
      await gsr.stop();
    } catch (e) {
      localError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  let displayError = $derived(localError ?? stream.error);
</script>

<div class="flex flex-col gap-3" data-testid="stream-controls">
  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <CircleIcon
        class="size-2.5 fill-current {stateColor} {stream.state === 'live'
          ? 'animate-pulse'
          : ''}"
      />
      <span class="text-text-bright text-sm font-semibold {stateColor}">{stateLabel}</span>
    </div>
    <div class="text-text-muted flex items-center gap-3 font-mono text-xs">
      <span data-testid="stream-fps">{stream.fps ?? '—'} fps</span>
      <span data-testid="stream-uptime">{uptimeLabel}</span>
    </div>
  </div>

  <div class="flex items-center gap-2">
    {#if stream.running}
      <Button
        type="button"
        variant="destructive"
        class="flex-1"
        onclick={onStop}
        disabled={!canStop}
        data-testid="stream-stop-btn"
      >
        <SquareIcon class="size-4" />
        {busy ? 'Stoppe…' : 'Stop'}
      </Button>
    {:else}
      <Button
        type="button"
        variant="default"
        class="flex-1"
        onclick={onStart}
        disabled={!canStart}
        data-testid="stream-start-btn"
      >
        <PlayIcon class="size-4" />
        {busy ? 'Starte…' : 'Stream starten'}
      </Button>
    {/if}
  </div>

  {#if !bridgeReady}
    <p class="text-text-muted text-xs italic" data-testid="stream-bridge-missing">
      Bridge nicht aktiv — Desktop-App nötig.
    </p>
  {/if}

  {#if displayError}
    <div
      class="flex items-start gap-2 rounded-md border border-red-700/60 bg-red-950/40 px-3 py-2 text-xs text-red-200"
      role="alert"
      data-testid="stream-error"
    >
      <AlertCircleIcon class="mt-0.5 size-4 shrink-0" />
      <span class="break-words">{displayError}</span>
    </div>
  {/if}
</div>
