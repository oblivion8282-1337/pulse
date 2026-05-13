<!--
  HqStreamButton — der Button im VoiceControlBar der das StreamPanel öffnet (T3c).

  Gating: nur sichtbar wenn `isElectron() && isLinux() && stream.gsrAvailable`
  (= die Electron-Sidecar-Bridge antwortet und das `gpu-screen-recorder`-Binary
  wurde gefunden). In jedem anderen Pfad rendert sich der Button nicht — der
  normale WebRTC-Screenshare-Button im Control-Bar bleibt der einzige
  Streaming-Pfad im Browser/Mac/Windows.

  UI: regulärer ghost/default-Button mit Tooltip. Wenn ein Stream läuft
  (`stream.running` true), bekommt das Icon einen kleinen Live-Indikator
  (roter Punkt rechts oben) — gleicher Stil wie Discord's "live"-Indikator.

  Click → öffnet `<HqStreamDialog>` (non-modal-ish, der Standard-Dialog-Backdrop
  ist klickbar zum Schließen). Der Channel-Header darunter bleibt sichtbar weil
  der Dialog mittig erscheint und kompakt ist.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
  import { isElectron, isLinux } from '$lib/platform/runtime';
  import { stream } from '../state.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import HqStreamDialog from './HqStreamDialog.svelte';

  let { open = $bindable(false), compact = false }: { open?: boolean; compact?: boolean } = $props();

  let visible = $derived(isElectron() && isLinux() && stream.gsrAvailable);
  // The voice channel we're connected to — passed to the StreamPanel so the
  // "Dieser Channel" target is available and the start flow can mint a token.
  let channelId = $derived(voice.channelId);
  // Live dot: our local sidecar is running, OR the WS broadcast says this
  // channel currently has an active HQ stream (could be us, could be someone
  // who started before we joined).
  let running = $derived(stream.running || (!!channelId && streamPresence.isStreaming(channelId)));
</script>

{#if visible}
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            variant={running ? 'default' : 'ghost'}
            size={compact ? 'icon-sm' : 'icon'}
            class="relative"
            onclick={() => (open = true)}
            aria-label="HQ-Stream öffnen"
            data-testid="voice-hq-stream-btn"
          >
            <RadioTowerIcon class={compact ? 'size-4' : ''} />
            {#if running}
              <span
                class="absolute right-1 top-1 size-2 rounded-full bg-red-500 ring-2 ring-bg-input"
                aria-hidden="true"
                data-testid="voice-hq-stream-live-dot"
              ></span>
            {/if}
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>
        {running ? 'HQ-Stream läuft — Panel öffnen' : 'HQ-Stream (GSR)'}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>

  <HqStreamDialog bind:open {channelId} />
{/if}
