<!--
  HqStreamButton — der Button im VoiceControlBar, der den HQ-Stream startet,
  stoppt oder die Settings öffnet.

  Gating: nur sichtbar wenn `isElectron() && (isLinux() || isWindows() || isMac()) && stream.gsrAvailable`.

  Verhalten (Variante "Rakete = Toggle"):
  - Ich streame nicht → Click öffnet `<HqStreamDialog>` (Settings + Start).
  - Ich streame  → Button leuchtet rot + Click stoppt direkt via `gsr.stop()`.
  - Jemand anders streamt im Channel → keine Auswirkung auf diesen Button.
    Fremde Streams sind über die WhepPlayer-Tiles im StreamGrid sichtbar.

  Hinweis: In der aktuellen Voice-Leiste wird stattdessen `ScreenShareModeButton`
  gerendert (Split-Button HQ/normal). Dieser Knopf bleibt als eigenständige
  Variante erhalten; der „+"-Zweitstream sitzt im ScreenShareModeButton.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import { isElectron, isLinux, isWindows, isMac } from '$lib/platform/runtime';
  import { stream } from '../state.svelte';
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

  async function onClick() {
    if (iAmStreaming) {
      try {
        await gsr.stop();
      } catch {
        /* WS-Broadcast holt den State eh nach */
      }
      return;
    }
    uiOverlays.hqStreamDialogOpen = true;
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

  <HqStreamDialog bind:open={uiOverlays.hqStreamDialogOpen} {channelId} />
{/if}
