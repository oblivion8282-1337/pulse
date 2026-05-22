<!--
  ScreenShareModeButton — kombinierter Split-Button für Screensharing.

  Wenn HQ verfügbar (Electron + Linux/Windows + gsrAvailable + STREAM-Permission):
    [Monitor/Rocket-Icon | ▾]  — linke Hälfte = Aktion, rechte = Modus-Auswahl
  Sonst: normaler Screenshare-Button ohne Dropdown.

  Modus wird in localStorage (pulse.ui.screenshare_mode) gespeichert.
  Nur für Desktop bestimmt — auf Mobile bleibt alles ausgeblendet.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import MonitorOffIcon from '@lucide/svelte/icons/monitor-off';
  import RocketIcon from '@lucide/svelte/icons/rocket';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { stream } from '$lib/stream/state.svelte';
  import { gsr } from '$lib/stream/gsr';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { isElectron, isLinux, isWindows } from '$lib/platform/runtime';
  import { Perm } from '$lib/permissions/bitfield';
  import ScreenSharePublishStats from './ScreenSharePublishStats.svelte';
  import HqStreamDialog from '$lib/stream/components/HqStreamDialog.svelte';
  import type { PublishStats } from '$lib/voice/screenShareStats';

  type ShareMode = 'normal' | 'hq';
  const STORAGE_KEY = 'pulse.ui.screenshare_mode';

  let publishStats = $state<PublishStats | null>(null);

  let canStream = $derived.by(() => {
    const cid = voice.channelId;
    if (!cid) return true;
    const ch = Object.values(guilds.channelsByGuild).flat().find((c) => c.id === cid);
    if (!ch) return true;
    return channelPermissions.hasChannelPermission(ch.guild_id, ch.id, Perm.STREAM);
  });

  let hqAvailable = $derived(
    isElectron() && (isLinux() || isWindows()) && stream.gsrAvailable && canStream
  );

  // Modus aus localStorage lesen; default 'hq' wenn verfügbar, sonst 'normal'
  let mode = $state<ShareMode>(
    (typeof localStorage !== 'undefined'
      ? (localStorage.getItem(STORAGE_KEY) as ShareMode | null)
      : null) ?? 'hq'
  );

  function setMode(m: ShareMode) {
    mode = m;
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, m);
  }

  // Aktiv-Status je Modus
  let isActive = $derived(mode === 'hq' ? stream.running : voice.isScreenSharing);

  async function doAction() {
    if (mode === 'normal') {
      try {
        await voice.setScreenShare(!voice.isScreenSharing);
      } catch {
        toast.info('Bildschirm teilen abgebrochen');
      }
      return;
    }
    // HQ
    if (stream.running) {
      try { await gsr.stop(); } catch { /* WS-Broadcast holt State nach */ }
    } else {
      uiOverlays.hqStreamDialogOpen = true;
    }
  }

  async function handleNormalShare() {
    try {
      await voice.setScreenShare(!voice.isScreenSharing);
    } catch {
      toast.info('Bildschirm teilen abgebrochen');
    }
  }

  let tooltipLabel = $derived.by(() => {
    if (!hqAvailable || mode === 'normal') {
      return voice.isScreenSharing ? 'Teilen beenden' : 'Bildschirm teilen';
    }
    return stream.running ? 'HQ-Stream beenden' : 'HQ-Stream';
  });
</script>

{#if hqAvailable}
  <!-- Split-Button: [Aktion | ▾ Modus-Dropdown] -->
  <Tooltip.Provider delayDuration={300}>
    <div class="relative flex items-center" data-testid="screenshare-mode-btn">
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              type="button"
              variant={isActive ? 'default' : 'ghost'}
              size="icon-sm"
              class="relative size-8 rounded-r-none border-r border-border/40"
              onclick={doAction}
              aria-label={tooltipLabel}
            >
              {#if mode === 'normal'}
                {#if voice.isScreenSharing}
                  <MonitorOffIcon class="size-4" />
                {:else}
                  <MonitorIcon class="size-4" />
                {/if}
                <ScreenSharePublishStats bind:stats={publishStats} />
              {:else}
                <RocketIcon class="size-4" />
                {#if stream.running}
                  <span
                    class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-red-500 ring-1 ring-bg-input"
                    aria-hidden="true"
                  ></span>
                {/if}
              {/if}
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>
          {tooltipLabel}
          {#if mode === 'normal' && voice.isScreenSharing && publishStats}
            <div class="text-text-muted mt-1 space-y-0.5 border-t border-border pt-1 text-[11px] tabular-nums">
              <div>Encoder: {publishStats.encoderImpl || '—'}{#if publishStats.encoderKind === 'gpu'} <span class="text-emerald-400">(GPU)</span>{:else if publishStats.encoderKind === 'cpu'} <span class="text-amber-400">(CPU)</span>{/if}</div>
              <div>Codec: {publishStats.codec}</div>
              <div>Auflösung: {publishStats.res}</div>
              <div>FPS: {publishStats.fps}</div>
              <div>Bitrate: {publishStats.bitrate}</div>
            </div>
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              type="button"
              variant="ghost"
              size="icon-sm"
              class="h-8 w-5 rounded-l-none px-0"
              aria-label="Streaming-Modus wählen"
            >
              <ChevronDownIcon class="size-3" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" class="min-w-[11rem]">
          <DropdownMenu.Item onclick={() => setMode('normal')} class="flex items-center gap-2">
            <MonitorIcon class="size-4 shrink-0" />
            <span class="flex-1">Standard</span>
            {#if mode === 'normal'}<CheckIcon class="size-3.5 text-primary" />{/if}
          </DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => setMode('hq')} class="flex items-center gap-2">
            <RocketIcon class="size-4 shrink-0" />
            <span class="flex-1">HQ-Streaming</span>
            {#if mode === 'hq'}<CheckIcon class="size-3.5 text-primary" />{/if}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </Tooltip.Provider>

  <HqStreamDialog bind:open={uiOverlays.hqStreamDialogOpen} channelId={voice.channelId} />

{:else}
  <!-- Kein HQ: normaler Screenshare-Button -->
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <span class="relative inline-flex">
            <Button
              {...props}
              type="button"
              variant={voice.isScreenSharing ? 'default' : 'ghost'}
              size="icon-sm"
              class="size-8"
              onclick={handleNormalShare}
              data-testid="voice-screenshare-toggle"
              aria-label={voice.isScreenSharing ? 'Bildschirm teilen beenden' : 'Bildschirm teilen'}
            >
              {#if voice.isScreenSharing}<MonitorOffIcon class="size-4" />{:else}<MonitorIcon class="size-4" />{/if}
            </Button>
            <ScreenSharePublishStats bind:stats={publishStats} />
          </span>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>
        <div>{voice.isScreenSharing ? 'Teilen beenden' : 'Bildschirm teilen'}</div>
        {#if voice.isScreenSharing && publishStats}
          <div class="text-text-muted mt-1 space-y-0.5 border-t border-border pt-1 text-[11px] tabular-nums">
            <div>Encoder: {publishStats.encoderImpl || '—'}{#if publishStats.encoderKind === 'gpu'} <span class="text-emerald-400">(GPU)</span>{:else if publishStats.encoderKind === 'cpu'} <span class="text-amber-400">(CPU)</span>{/if}</div>
            <div>Codec: {publishStats.codec}</div>
            <div>Auflösung: {publishStats.res}</div>
            <div>FPS: {publishStats.fps}</div>
            <div>Bitrate: {publishStats.bitrate}</div>
          </div>
        {/if}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
