<!--
  StreamControls — der Start/Stop-Button + Live-Status-Block.

  Liest `stream` aus `state.svelte.ts` (running, state, fps, uptimeS, error).
  Beim Start (immer Channel-Modus — Pulse streamt in den aktuellen Voice-Channel):
  erst `chatApi.getStreamToken(channelId)` (chat-gateway → media-svc proxy),
  dann `gsr.start(buildStartArgs({channelId, token, pushUrl}))`. Fehler
  (403 nicht-Member, 400 kein Voice-Channel, 502 media-svc down …) → `toast.error`.
  Der Stream-Indikator (auch beim Streamer selbst) kommt danach über den
  WS-`stream_state`-Broadcast — media-svc's Poller erkennt den Publisher;
  wir müssen chat-gateway nichts melden. Stop: `gsr.stop()`. Disable wenn
  Bridge nicht verfügbar.

  Uptime-Anzeige: Wir rechnen `mm:ss` selbst aus `stream.uptimeS`. Der
  Sidecar feuert FPS-Events nur alle ~1 s, also reicht das als Trigger für
  re-render — kein eigener Timer nötig.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import PlayIcon from '@lucide/svelte/icons/play';
  import SquareIcon from '@lucide/svelte/icons/square';
  import CircleIcon from '@lucide/svelte/icons/circle';
  import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { ApiError } from '$lib/api/client';
  import { gsr } from '../gsr';
  import { stream, streamForSlot, markStopped } from '../state.svelte';
  import {
    buildStartArgs,
    streamSettings,
    isAppAudioMode,
    appFromAudioMode,
    pushProtokoll,
    tenBitPossible,
  } from '../settings.svelte';
  import { resolveSlotLabel } from '../label';
  import { recordStreamStart } from '../autoRestart';

  let {
    channelId = null,
    // `slot` is a reserved attribute name in Svelte, so the prop is `streamSlot`
    // on the outside; alias it back to the simpler `slot` inside.
    streamSlot: slot = 0,
    onStarted,
  }: { channelId?: string | null; streamSlot?: number; onStarted?: () => void } = $props();

  // This control drives ONE stream slot; `session` is that slot's live state
  // (0 = primary `stream`, 1 = the second stream). The global bridge flag still
  // lives on `stream`.
  let session = $derived(streamForSlot(slot));

  let busy = $state(false);
  let localError = $state<string | null>(null);

  let bridgeReady = $derived(gsr.available() && stream.available);
  // "Bestimmte App" without an app picked yet → can't start (GSR `-a "app:"` fails).
  let appAudioReady = $derived(
    !isAppAudioMode(streamSettings.audio_mode) || !!appFromAudioMode(streamSettings.audio_mode),
  );
  let canStart = $derived(
    bridgeReady &&
      !session.running &&
      !busy &&
      !!streamSettings.profile_name &&
      appAudioReady &&
      !!channelId,
  );
  let canStop = $derived(bridgeReady && session.running && !busy);

  function formatUptime(s: number | null): string {
    if (s == null || s < 0) return '00:00';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  let uptimeLabel = $derived(formatUptime(session.uptimeS));
  let stateLabel = $derived.by(() => {
    switch (session.state) {
      case 'starting':
        return 'Connecting…';
      case 'live':
        return 'Live';
      case 'error':
        return m.stream_controls_state_error();
      case 'stopped':
        return m.stream_controls_state_stopped();
      default:
        return 'Idle';
    }
  });
  let stateColor = $derived.by(() => {
    switch (session.state) {
      case 'starting':
        return 'text-warning';
      case 'live':
        return 'text-success';
      case 'error':
        return 'text-destructive';
      default:
        return 'text-text-muted';
    }
  });

  async function onStart() {
    if (!channelId) return;
    busy = true;
    localError = null;
    try {
      let tok;
      try {
        // Resolve the human-readable label (e.g. "Monitor 1", "Chrome") once at
        // start so viewers' picker can name this stream without the GSR catalogs.
        const label = resolveSlotLabel(slot).label;
        // Warum Betriebsart UND Codec den Transport mitentscheiden: s. `pushProtokoll`.
        tok = await chatApi.getStreamToken(
          channelId,
          pushProtokoll(),
          slot,
          label,
          tenBitPossible(),
          // Ferngesteuert werden kann nur, wessen Sidecar Eingaben einspielen
          // kann — heute allein der Windows-Sidecar. Der Wert reist mit dem
          // Stream bis zum Zuschauer und entscheidet dort, ob der Anfrage-Knopf
          // erscheint (`RemoteRequestButton`).
          stream.fernsteuerbar
        );
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.status === 403
              ? m.stream_controls_error_not_member()
              : e.status === 400
                ? m.stream_controls_error_not_voice_channel()
                : e.status === 502 || e.status === 503
                  ? m.stream_controls_error_media_svc_unavailable()
                  : (e.message ?? m.stream_controls_error_token_fetch_failed())
            : e instanceof Error
              ? e.message
              : String(e);
        toast.error(m.stream_controls_toast_start_failed(), { description: msg });
        return;
      }
      const args = buildStartArgs(
        {
          channelId,
          token: tok.token,
          pushUrl: tok.push_url,
        },
        slot,
      );
      const r = await gsr.start(args, slot);
      if (r && !r.ok) {
        localError = r.error ?? m.stream_controls_error_start_failed();
        toast.error(m.stream_controls_toast_start_failed(), { description: localError });
      } else {
        // Record the channelId for auto-restart-after-resize-change (autoRestart.ts
        // has no other way to learn it).
        recordStreamStart(slot, channelId);
        onStarted?.();
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
      // The backend is told the stream stopped centrally, when the sidecar
      // emits its `stopped` event (see stream/state.svelte.ts) — that covers
      // every stop path (this dialog button, the rocket toggle, the hotkey,
      // a voice-channel switch), so there's nothing to notify here.
      await gsr.stop(slot);
      // Reconcile locally — a stop after a crash hits a fresh sidecar that
      // emits no `stopped` event, so the UI would otherwise stay stuck "live".
      markStopped(slot);
    } catch (e) {
      localError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  let displayError = $derived(localError ?? session.error);
</script>

<div class="flex flex-col gap-3" data-testid="stream-controls">
  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <CircleIcon
        class="size-2.5 fill-current {stateColor} {session.state === 'live'
          ? 'animate-pulse'
          : ''}"
      />
      <span class="text-text-bright text-sm font-semibold {stateColor}">{stateLabel}</span>
    </div>
    <div class="text-text-muted flex items-center gap-3 font-mono text-xs">
      <span data-testid="stream-fps">{session.fps ?? '—'} fps</span>
      <span data-testid="stream-uptime">{uptimeLabel}</span>
    </div>
  </div>

  <div class="flex items-center gap-2">
    {#if session.running}
      <Button
        type="button"
        variant="destructive"
        class="flex-1"
        onclick={onStop}
        disabled={!canStop}
        data-testid="stream-stop-btn"
      >
        <SquareIcon class="size-4" />
        {busy ? m.stream_controls_btn_stopping() : 'Stop'}
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
        {busy ? m.stream_controls_btn_starting() : m.stream_controls_btn_start()}
      </Button>
    {/if}
  </div>

  {#if !bridgeReady}
    <p class="text-text-muted text-xs italic" data-testid="stream-bridge-missing">
      {m.stream_controls_bridge_missing()}
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
