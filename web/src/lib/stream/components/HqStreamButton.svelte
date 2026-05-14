<!--
  HqStreamButton — der Button im VoiceControlBar, der den HQ-Stream startet,
  stoppt oder die Settings öffnet.

  Gating: nur sichtbar wenn `isElectron() && isLinux() && stream.gsrAvailable`.

  Verhalten (Variante "Rakete = Toggle"):
  - Ich streame nicht → Click öffnet `<HqStreamDialog>` (Settings + Start).
  - Ich streame  → Button leuchtet rot + Click stoppt direkt via `gsr.stop()`.
  - Jemand anders streamt im Channel → keine Auswirkung auf diesen Button.
    Fremde Streams sind über die WhepPlayer-Tiles im StreamGrid sichtbar.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import { isElectron, isLinux } from '$lib/platform/runtime';
  import { stream } from '../state.svelte';
  import { gsr } from '../gsr';
  import { voice } from '$lib/voice/livekit.svelte';
  import HqStreamDialog from './HqStreamDialog.svelte';

  let { open = $bindable(false), compact = false }: { open?: boolean; compact?: boolean } = $props();

  let visible = $derived(isElectron() && isLinux() && stream.gsrAvailable);
  let channelId = $derived(voice.channelId);
  // Lokaler Sidecar pusht gerade → Click = Stop, Button leuchtet.
  let iAmStreaming = $derived(stream.running);

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
            variant={iAmStreaming ? 'default' : 'ghost'}
            size={compact ? 'icon-sm' : 'icon'}
            class="relative"
            onclick={onClick}
            aria-label={iAmStreaming ? 'HQ-Stream beenden' : 'HQ-Stream öffnen'}
            data-testid="voice-hq-stream-btn"
          >
            <RocketIcon class={compact ? 'size-4' : ''} />
            {#if iAmStreaming}
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
        {iAmStreaming ? 'HQ-Stream beenden' : 'HQ-Stream'}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>

  <HqStreamDialog bind:open {channelId} />
{/if}
