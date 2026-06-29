<!--
  HqStreamButton — der Button im VoiceControlBar, der den HQ-Stream startet,
  stoppt oder die Settings öffnet.

  Gating: nur sichtbar wenn `isElectron() && (isLinux() || isWindows() || isMac()) && stream.gsrAvailable`.

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
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { isElectron, isLinux, isWindows, isMac } from '$lib/platform/runtime';
  import { stream, streamExtra } from '../state.svelte';
  import { streamSettings } from '../settings.svelte';
  import { gsr } from '../gsr';
  import { voice } from '$lib/voice/livekit.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import HqStreamDialog from './HqStreamDialog.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { compact = false }: { compact?: boolean } = $props();

  let channelId = $derived(voice.channelId);
  // STREAM-Permission im aktuellen Voice-Channel — Resolver liefert
  // GRANT_ALL_SAFE für Owner. Wenn kein Channel oder kein Guild für
  // den Channel im Store ist (z.B. DM), fällt das ungated zurück (das
  // war's auch vor Phase 4).
  let canStream = $derived.by(() => {
    if (!channelId) return true;
    const channel = Object.values(guilds.channelsByGuild)
      .flat()
      .find((c) => c.id === channelId);
    if (!channel) return true;
    return channelPermissions.hasChannelPermission(channel.guild_id, channel.id, Perm.STREAM);
  });
  let visible = $derived(
    isElectron() && (isLinux() || isWindows() || isMac()) && stream.gsrAvailable && canStream,
  );
  // Lokaler Sidecar pusht gerade → Click = Stop, Button leuchtet.
  let iAmStreaming = $derived(stream.running);
  let secondRunning = $derived(streamExtra.running);
  // Den Zweitstream-Knopf zeigen, wenn Slot 1 schon läuft (dann ist es der
  // Stop-Knopf — muss sichtbar bleiben, auch wenn Slot 0 inzwischen aus ist)
  // ODER wenn der erste Stream läuft und es kein sicheres Einzelmonitor-Setup
  // ist (genau 1 erkannter Monitor). Linux meldet keine Monitore in-App
  // (Portal), 0 = unbekannt → erlauben.
  let canSecond = $derived(
    secondRunning || (iAmStreaming && streamSettings.available_monitors.length !== 1),
  );
  let secondDialogOpen = $state(false);

  // Stop one slot's stream; the WS-Broadcast reconciles the state afterwards.
  async function stopSlot(slot: number) {
    try {
      await gsr.stop(slot);
    } catch {
      /* WS-Broadcast holt den State eh nach */
    }
  }

  async function onClick() {
    if (iAmStreaming) {
      await stopSlot(0);
      return;
    }
    uiOverlays.hqStreamDialogOpen = true;
  }

  async function onSecondClick() {
    if (secondRunning) {
      await stopSlot(1);
      return;
    }
    secondDialogOpen = true;
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
            aria-label={iAmStreaming ? m.hq_stream_button_stop() : m.hq_stream_button_open()}
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
        {iAmStreaming ? m.hq_stream_button_stop() : m.hq_stream_button_tooltip()}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>

  {#if canSecond}
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              type="button"
              variant={secondRunning ? 'default' : 'ghost'}
              size={compact ? 'icon-sm' : 'icon'}
              class="relative"
              onclick={onSecondClick}
              aria-label={secondRunning
                ? m.hq_stream_button_second_stop()
                : m.hq_stream_button_second_open()}
              data-testid="voice-hq-stream-btn-2"
            >
              <PlusIcon class={compact ? 'size-4' : ''} />
              {#if secondRunning}
                <span
                  class="absolute right-1 top-1 size-2 rounded-full bg-red-500 ring-2 ring-bg-input"
                  aria-hidden="true"
                  data-testid="voice-hq-stream-live-dot-2"
                ></span>
              {/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {secondRunning ? m.hq_stream_button_second_stop() : m.hq_stream_button_second_open()}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  {/if}

  <HqStreamDialog bind:open={uiOverlays.hqStreamDialogOpen} {channelId} />
  <HqStreamDialog bind:open={secondDialogOpen} {channelId} streamSlot={1} />
{/if}
