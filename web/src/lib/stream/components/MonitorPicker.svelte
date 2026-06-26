<!--
  MonitorPicker — Quellen-Auswahl (Bildschirm ODER Fenster) für den HQ-Stream
  auf Windows + macOS.

  Unter Linux nie gerendert: dort übernimmt der Wayland-Portal-Dialog die
  Quellen-Auswahl beim Stream-Start. Windows/WGC + macOS/SCK haben keinen
  Portal-Picker — ohne diese Auswahl bekäme man immer den Primärmonitor.

  Kein natives <select> mehr: dessen aufgeklapptes Options-Menü zeichnet
  Chromium/Windows selbst mit dem OS-Theme (weißer Hintergrund im Dark-Mode,
  nicht stylebar). Stattdessen ein Kachel-Picker (Radio-Stil, themed).

  Der Wert landet in `capture_source` (`ops/start.rs::parse_capture` löst auf):
   - Monitor → `"Monitor: <index>"` (1-basiert, matcht `list_monitors`,
     via `Monitor::from_index`).
   - Fenster → `"window:<id>"` (id aus `list_windows`; HWND auf Windows,
     CoreGraphics-id auf macOS).
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import AppWindowIcon from '@lucide/svelte/icons/app-window';
  import {
    streamSettings,
    persistSettings,
    refreshMonitors,
    refreshWindows,
    MONITOR_CAPTURE_PREFIX,
    WINDOW_CAPTURE_PREFIX,
  } from '../settings.svelte';

  let refreshing = $state(false);

  function pick(value: string) {
    streamSettings.capture_source = value;
    persistSettings();
  }

  async function onRefresh() {
    refreshing = true;
    try {
      await Promise.all([refreshMonitors(), refreshWindows()]);
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="flex flex-col gap-2" data-testid="stream-monitor-picker">
  <div class="flex items-center justify-between">
    <Label>{m.monitor_picker_label()}</Label>
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onclick={onRefresh}
      disabled={refreshing}
      aria-label={m.monitor_picker_refresh_aria()}
      data-testid="stream-monitor-refresh"
    >
      <RefreshIcon class="size-3 {refreshing ? 'animate-spin' : ''}" />
      Refresh
    </Button>
  </div>

  {#if streamSettings.available_monitors.length === 0 && streamSettings.available_windows.length === 0}
    <p class="text-text-muted text-xs italic" data-testid="stream-monitor-empty">
      {m.monitor_picker_empty()}
    </p>
  {:else}
    <div role="radiogroup" aria-label={m.monitor_picker_label()} class="flex flex-col gap-3">
      {#if streamSettings.available_monitors.length > 0}
        <div class="flex flex-col gap-1.5">
          <span class="text-text-muted text-[0.65rem] font-semibold tracking-wide uppercase">
            {m.monitor_picker_group_displays()}
          </span>
          <div class="grid grid-cols-2 gap-2">
            {#each streamSettings.available_monitors as mon (mon.index)}
              {@const value = `${MONITOR_CAPTURE_PREFIX}${mon.index}`}
              {@const selected = streamSettings.capture_source === value}
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onclick={() => pick(value)}
                data-testid="stream-monitor-tile"
                class="flex min-w-0 items-start gap-2 rounded-lg border p-2.5 text-left transition-colors
                  {selected
                  ? 'border-primary bg-primary/10 text-text-bright'
                  : 'border-border bg-bg-chat text-text-base hover:border-primary/50'}"
              >
                <MonitorIcon class="mt-0.5 size-4 shrink-0 {selected ? 'text-primary' : 'text-text-muted'}" />
                <span class="flex min-w-0 flex-col">
                  <span class="truncate text-xs font-medium">
                    {m.monitor_picker_option_label({ index: mon.index, name: mon.name })}
                  </span>
                  <span class="text-text-muted truncate text-[0.65rem]">
                    {mon.primary ? `${m.monitor_picker_option_primary()} · ` : ''}{mon.width
                      ? m.monitor_picker_option_resolution({ width: mon.width, height: mon.height })
                      : ''}
                  </span>
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if streamSettings.available_windows.length > 0}
        <div class="flex flex-col gap-1.5">
          <span class="text-text-muted text-[0.65rem] font-semibold tracking-wide uppercase">
            {m.monitor_picker_group_windows()}
          </span>
          <div class="grid max-h-44 grid-cols-2 gap-2 overflow-y-auto pr-1">
            {#each streamSettings.available_windows as w (w.id)}
              {@const value = `${WINDOW_CAPTURE_PREFIX}${w.id}`}
              {@const selected = streamSettings.capture_source === value}
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onclick={() => pick(value)}
                data-testid="stream-window-tile"
                title={w.title ? `${w.app} — ${w.title}` : w.app}
                class="flex min-w-0 items-start gap-2 rounded-lg border p-2.5 text-left transition-colors
                  {selected
                  ? 'border-primary bg-primary/10 text-text-bright'
                  : 'border-border bg-bg-chat text-text-base hover:border-primary/50'}"
              >
                <AppWindowIcon class="mt-0.5 size-4 shrink-0 {selected ? 'text-primary' : 'text-text-muted'}" />
                <span class="flex min-w-0 flex-col">
                  <span class="truncate text-xs font-medium">{w.app}</span>
                  {#if w.title}
                    <span class="text-text-muted truncate text-[0.65rem]">{w.title}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
