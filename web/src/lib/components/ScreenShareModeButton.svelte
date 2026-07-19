<!--
  ScreenShareModeButton — kombinierter Split-Button für Screensharing.

  Wenn HQ verfügbar (Electron + Linux/Windows/macOS + gsrAvailable + STREAM-Permission):
    [Aktion/Stop | ▾ Modus  bzw. + Weiterer Stream]
    - linke Hälfte: kein Stream → Start-Dialog; genau ein Stream → Stop; mehrere
      Streams → Dropdown zum Auswählen, welcher beendet wird.
    - rechte Hälfte: kein Stream → Modus-Auswahl (▾ HQ/normal); läuft ein Stream
      → „+" (öffnet den Dialog für einen weiteren Stream, eigener Monitor).
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
  import PlusIcon from '@lucide/svelte/icons/plus';
  import CheckIcon from '@lucide/svelte/icons/check';
  import SquareIcon from '@lucide/svelte/icons/square';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { stream, runningStreamSlots } from '$lib/stream/state.svelte';
  import { nextFreeStreamSlot, stopSlot, stopAll } from '$lib/stream/slotControl.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { isElectron, isLinux, isWindows, isMac } from '$lib/platform/runtime';
  import { Perm } from '$lib/permissions/bitfield';
  import ScreenSharePublishStats from './ScreenSharePublishStats.svelte';
  import HqStreamDialog from '$lib/stream/components/HqStreamDialog.svelte';
  import type { PublishStats } from '$lib/voice/screenShareStats';
  import { m } from '$lib/paraglide/messages.js';

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
    isElectron() && (isLinux() || isWindows() || isMac()) && stream.gsrAvailable && canStream
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

  // Welche HQ-Streams (Slots) gerade laufen.
  let runningSlots = $derived(runningStreamSlots());
  let anyHqRunning = $derived(runningSlots.length > 0);
  // Niedrigster freier Slot — den startet das „+" als nächsten Stream.
  let nextFreeSlot = $derived(nextFreeStreamSlot());
  // Rechte Hälfte ist „+" sobald ein Stream läuft und noch Platz ist; sonst ▾.
  let showPlus = $derived(mode === 'hq' && anyHqRunning && nextFreeSlot >= 0);
  // Linke Hälfte wird ein Stop-Auswahl-Dropdown, sobald MEHRERE Streams laufen.
  let showStopMenu = $derived(mode === 'hq' && runningSlots.length > 1);

  // Aktiv-Status je Modus (Button „leuchtet").
  let isActive = $derived(mode === 'hq' ? anyHqRunning : voice.isScreenSharing);

  // Dialog für einen ZUSÄTZLICHEN Stream (das „+"): an einen konkreten Slot
  // gebunden, den der User dann im Dialog einrichtet + startet.
  let addDialogOpen = $state(false);
  let addDialogSlot = $state(0);
  function openAdd() {
    if (nextFreeSlot < 0) return;
    addDialogSlot = nextFreeSlot;
    addDialogOpen = true;
  }

  // setScreenShare setzt isScreenSharing erst NACH dem await (getDisplayMedia);
  // ohne In-Flight-Guard startet ein Doppelklick zwei getDisplayMedia-Sessions,
  // die zweite überschreibt #bypassVideoTrack → erste Capture bleibt verwaist.
  let sharing = $state(false);

  async function doAction() {
    if (mode === 'normal') {
      await handleNormalShare();
      return;
    }
    // HQ — bei MEHREREN Streams übernimmt das Stop-Dropdown (doAction nicht
    // verdrahtet). Hier nur die Fälle 0 Streams (→ Start) und 1 Stream (→ Stop).
    if (runningSlots.length === 1) {
      await stopSlot(runningSlots[0]);
    } else {
      uiOverlays.hqStreamDialogOpen = true;
    }
  }

  async function handleNormalShare() {
    if (sharing) return;
    sharing = true;
    try {
      await voice.setScreenShare(!voice.isScreenSharing);
    } catch {
      toast.info(m.screen_share_mode_button_share_cancelled());
    } finally {
      sharing = false;
    }
  }

  let tooltipLabel = $derived.by(() => {
    if (!hqAvailable || mode === 'normal') {
      return voice.isScreenSharing ? m.screen_share_mode_button_stop_sharing() : m.screen_share_mode_button_share_screen();
    }
    return anyHqRunning ? m.screen_share_mode_button_stop_hq_stream() : m.screen_share_mode_button_hq_stream();
  });
</script>

{#if hqAvailable}
  <!-- Split-Button: [Aktion/Stop | ▾ Modus  bzw.  + Weiterer Stream] -->
  <Tooltip.Provider delayDuration={300}>
    <div class="relative flex items-center" data-testid="screenshare-mode-btn">
      {#if showStopMenu}
        <!-- Mehrere Streams → Dropdown: welchen beenden? -->
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                type="button"
                variant="default"
                size="icon-sm"
                class="relative size-8 rounded-l-full rounded-r-none border-r border-border/40"
                aria-label={m.screen_share_stop_pick()}
                data-testid="screenshare-stop-menu-btn"
              >
                <RocketIcon class="size-4" />
                <span
                  class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-red-500 ring-1 ring-bg-input"
                  aria-hidden="true"
                ></span>
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" class="min-w-[12rem]">
            <div class="text-text-muted px-2 py-1.5 text-xs font-semibold">
              {m.screen_share_stop_pick()}
            </div>
            {#each runningSlots as slot (slot)}
              <DropdownMenu.Item onclick={() => stopSlot(slot)} class="flex items-center gap-2">
                <SquareIcon class="size-3.5 shrink-0 text-destructive" />
                <span class="flex-1">{m.screen_share_stop_stream_n({ n: slot + 1 })}</span>
              </DropdownMenu.Item>
            {/each}
            <DropdownMenu.Separator />
            <DropdownMenu.Item onclick={stopAll} class="flex items-center gap-2 text-destructive">
              <SquareIcon class="size-3.5 shrink-0" />
              <span class="flex-1">{m.screen_share_stop_all_streams()}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {:else}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                type="button"
                variant={isActive ? 'default' : 'ghost'}
                size="icon-sm"
                class="relative size-8 rounded-l-full rounded-r-none border-r border-border/40"
                onclick={doAction}
                disabled={sharing}
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
                  {#if anyHqRunning}
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
                <div>{m.screen_share_mode_button_stats_encoder({ value: publishStats.encoderImpl || '—' })}{#if publishStats.encoderKind === 'gpu'} <span class="text-emerald-400">(GPU)</span>{:else if publishStats.encoderKind === 'cpu'} <span class="text-amber-400">(CPU)</span>{/if}</div>
                <div>{m.screen_share_mode_button_stats_codec({ value: publishStats.codec })}</div>
                <div>{m.screen_share_mode_button_stats_resolution({ value: publishStats.res })}</div>
                <div>{m.screen_share_mode_button_stats_fps({ value: publishStats.fps })}</div>
                <div>{m.screen_share_mode_button_stats_bitrate({ value: publishStats.bitrate })}</div>
              </div>
            {/if}
          </Tooltip.Content>
        </Tooltip.Root>
      {/if}

      {#if showPlus}
        <!-- Läuft ein Stream → „+": Dialog für den nächsten Stream öffnen. -->
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon-sm"
                class="h-8 w-5 rounded-l-none rounded-r-full px-0"
                onclick={openAdd}
                aria-label={m.screen_share_add_stream()}
                data-testid="screenshare-add-btn"
              >
                <PlusIcon class="size-3" />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>{m.screen_share_add_stream()}</Tooltip.Content>
        </Tooltip.Root>
      {:else}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon-sm"
                class="h-8 w-5 rounded-l-none rounded-r-full px-0"
                aria-label={m.screen_share_mode_button_select_mode()}
              >
                <ChevronDownIcon class="size-3" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" class="min-w-[11rem]">
            <DropdownMenu.Item onclick={() => setMode('normal')} class="flex items-center gap-2">
              <MonitorIcon class="size-4 shrink-0" />
              <span class="flex-1">{m.screen_share_mode_button_mode_standard()}</span>
              {#if mode === 'normal'}<CheckIcon class="size-3.5 text-primary" />{/if}
            </DropdownMenu.Item>
            <DropdownMenu.Item onclick={() => setMode('hq')} class="flex items-center gap-2">
              <RocketIcon class="size-4 shrink-0" />
              <span class="flex-1">{m.screen_share_mode_button_mode_hq()}</span>
              {#if mode === 'hq'}<CheckIcon class="size-3.5 text-primary" />{/if}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    </div>
  </Tooltip.Provider>

  <HqStreamDialog bind:open={uiOverlays.hqStreamDialogOpen} channelId={voice.channelId} />
  <HqStreamDialog bind:open={addDialogOpen} channelId={voice.channelId} streamSlot={addDialogSlot} />

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
              disabled={sharing}
              data-testid="voice-screenshare-toggle"
              aria-label={voice.isScreenSharing ? m.screen_share_mode_button_stop_sharing_long() : m.screen_share_mode_button_share_screen()}
            >
              {#if voice.isScreenSharing}<MonitorOffIcon class="size-4" />{:else}<MonitorIcon class="size-4" />{/if}
            </Button>
            <ScreenSharePublishStats bind:stats={publishStats} />
          </span>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>
        <div>{voice.isScreenSharing ? m.screen_share_mode_button_stop_sharing() : m.screen_share_mode_button_share_screen()}</div>
        {#if voice.isScreenSharing && publishStats}
          <div class="text-text-muted mt-1 space-y-0.5 border-t border-border pt-1 text-[11px] tabular-nums">
            <div>{m.screen_share_mode_button_stats_encoder({ value: publishStats.encoderImpl || '—' })}{#if publishStats.encoderKind === 'gpu'} <span class="text-emerald-400">(GPU)</span>{:else if publishStats.encoderKind === 'cpu'} <span class="text-amber-400">(CPU)</span>{/if}</div>
            <div>{m.screen_share_mode_button_stats_codec({ value: publishStats.codec })}</div>
            <div>{m.screen_share_mode_button_stats_resolution({ value: publishStats.res })}</div>
            <div>{m.screen_share_mode_button_stats_fps({ value: publishStats.fps })}</div>
            <div>{m.screen_share_mode_button_stats_bitrate({ value: publishStats.bitrate })}</div>
          </div>
        {/if}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
