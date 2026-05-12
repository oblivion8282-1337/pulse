<!--
  StreamControls — der Start/Stop-Button + Live-Status-Block.

  Liest `stream` aus `state.svelte.ts` (running, state, fps, uptimeS, error).
  Beim Start:
  - Channel-Modus (`streamSettings.target === 'channel'` + `channelId` prop):
    erst `chatApi.getStreamToken(channelId)` (chat-gateway → media-svc proxy),
    dann `gsr.start(buildStartArgs(_, {channelId, token, mediamtxEndpoint,
    pushProtocol}))`. Fehler (403 nicht-Member, 400 kein Voice-Channel, 502
    media-svc down …) → `toast.error`. Der Stream-Indikator (auch beim Streamer
    selbst) kommt danach über den WS-`stream_state`-Broadcast — media-svc's
    Poller erkennt den Publisher; wir müssen chat-gateway nichts melden.
  - Server-Modus: wie gehabt `gsr.start(buildStartArgs())`.
  Stop: `gsr.stop()`. Disable wenn Bridge nicht verfügbar.

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
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import { gsr } from '../gsr';
  import { stream } from '../state.svelte';
  import { buildStartArgs, streamSettings, mediamtxEndpointFromPushUrl } from '../settings.svelte';

  let { channelId = null }: { channelId?: string | null } = $props();

  let busy = $state(false);
  let localError = $state<string | null>(null);

  let channelMode = $derived(streamSettings.target === 'channel' && !!channelId);
  let bridgeReady = $derived(gsr.available() && stream.available);
  let canStart = $derived(
    bridgeReady &&
      !stream.running &&
      !busy &&
      !!streamSettings.profile_name &&
      (channelMode || !!streamSettings.server_name),
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
      let args = buildStartArgs();
      if (channelMode && channelId) {
        let tok;
        try {
          tok = await chatApi.getStreamToken(channelId, 'rtmp');
        } catch (e) {
          const msg =
            e instanceof ApiError
              ? e.status === 403
                ? 'Du bist kein Mitglied dieses Kanals.'
                : e.status === 400
                  ? 'HQ-Streaming geht nur in Sprach-Kanälen.'
                  : e.status === 502 || e.status === 503
                    ? 'Der Media-Dienst ist nicht erreichbar.'
                    : (e.message ?? 'Stream-Token konnte nicht geholt werden.')
              : e instanceof Error
                ? e.message
                : String(e);
          toast.error('Stream konnte nicht gestartet werden', { description: msg });
          return;
        }
        args = buildStartArgs(undefined, {
          channelId,
          token: tok.token,
          mediamtxEndpoint: mediamtxEndpointFromPushUrl(tok.push_url),
          pushProtocol: tok.push_protocol,
        });
      }
      const r = await gsr.start(args);
      if (r && !r.ok) {
        localError = r.error ?? 'Start fehlgeschlagen.';
        if (channelMode) toast.error('Stream konnte nicht gestartet werden', { description: localError });
      }
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
