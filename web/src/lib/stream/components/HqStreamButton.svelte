<!--
  HqStreamButton — der Button im VoiceControlBar, der den HQ-Stream startet,
  stoppt oder die Settings öffnet.

  Gating: nur sichtbar wenn `isElectron() && isLinux() && stream.gsrAvailable`.

  Verhalten (Variante "Rakete = Toggle"):
  - Ich streame nicht → Click öffnet `<HqStreamDialog>` (Settings + Start).
  - Ich streame  → Click stoppt direkt via `gsr.stop()`, ohne Dialog.
  - Jemand anders streamt in diesem Channel → Button leuchtet trotzdem rot
    als Channel-Indikator, Click öffnet aber den Dialog (um selbst zu
    starten oder die Settings zu sehen).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import { isElectron, isLinux } from '$lib/platform/runtime';
  import { stream } from '../state.svelte';
  import { gsr } from '../gsr';
  import { voice } from '$lib/voice/livekit.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import HqStreamDialog from './HqStreamDialog.svelte';

  let { open = $bindable(false), compact = false }: { open?: boolean; compact?: boolean } = $props();

  let visible = $derived(isElectron() && isLinux() && stream.gsrAvailable);
  let channelId = $derived(voice.channelId);
  // Lokaler Sidecar pusht gerade → Click = Stop.
  let iAmStreaming = $derived(stream.running);
  // Akzentuierter "live"-State: ich oder jemand sonst pusht im Channel.
  let channelHasStream = $derived(
    iAmStreaming || (!!channelId && streamPresence.isStreaming(channelId)),
  );

  async function onClick() {
    if (iAmStreaming) {
      try {
        await gsr.stop();
      } catch {
        /* WS-Broadcast holt den State eh nach */
      }
      return;
    }
    open = true;
  }
</script>

{#if visible}
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            variant={channelHasStream ? 'default' : 'ghost'}
            size={compact ? 'icon-sm' : 'icon'}
            class="relative"
            onclick={onClick}
            aria-label={iAmStreaming ? 'HQ-Stream beenden' : 'HQ-Stream öffnen'}
            data-testid="voice-hq-stream-btn"
          >
            <RocketIcon class={compact ? 'size-4' : ''} />
            {#if channelHasStream}
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
        {iAmStreaming
          ? 'HQ-Stream beenden'
          : channelHasStream
            ? 'HQ-Stream läuft — Panel öffnen'
            : 'HQ-Stream'}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>

  <HqStreamDialog bind:open {channelId} />
{/if}
