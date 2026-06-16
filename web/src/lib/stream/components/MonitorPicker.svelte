<!--
  MonitorPicker — Windows-only Bildschirm-Auswahl für den HQ-Stream.

  Unter Linux nie gerendert: dort übernimmt der Wayland-Portal-Dialog die
  Quellen-Auswahl beim Stream-Start. Windows/WGC hat keinen Portal-Picker —
  ohne diese Auswahl bekäme man immer den Primärmonitor.

  Der Wert landet als `capture_source = "Monitor: <index>"` in den
  streamSettings; der Windows-Sidecar (`ops/start.rs::parse_capture`) löst das
  via `Monitor::from_index` auf. `index` ist 1-basiert und matcht die
  `list_monitors`-Enumeration.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import {
    streamSettings,
    persistSettings,
    refreshMonitors,
    refreshWindows,
    MONITOR_CAPTURE_PREFIX,
    WINDOW_CAPTURE_PREFIX,
  } from '../settings.svelte';

  let refreshing = $state(false);

  function onPick(e: Event) {
    streamSettings.capture_source = (e.currentTarget as HTMLSelectElement).value;
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
    <Label for="stream-monitor-select">{m.monitor_picker_label()}</Label>
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
    <select
      id="stream-monitor-select"
      class="bg-bg-chat text-text-base h-8 rounded-md px-2 text-xs outline-none"
      value={streamSettings.capture_source}
      onchange={onPick}
      data-testid="stream-monitor-select"
    >
      {#if streamSettings.available_monitors.length > 0}
        <optgroup label={m.monitor_picker_group_displays()}>
          {#each streamSettings.available_monitors as mon (mon.index)}
            <option value={`${MONITOR_CAPTURE_PREFIX}${mon.index}`}>
              {m.monitor_picker_option_label({ index: mon.index, name: mon.name })}{mon.primary ? ` ${m.monitor_picker_option_primary()}` : ''}{mon.width
                ? ` ${m.monitor_picker_option_resolution({ width: mon.width, height: mon.height })}`
                : ''}
            </option>
          {/each}
        </optgroup>
      {/if}
      {#if streamSettings.available_windows.length > 0}
        <optgroup label={m.monitor_picker_group_windows()}>
          {#each streamSettings.available_windows as w (w.id)}
            <option value={`${WINDOW_CAPTURE_PREFIX}${w.id}`}>
              {w.app}{w.title ? ` — ${w.title}` : ''}
            </option>
          {/each}
        </optgroup>
      {/if}
    </select>
  {/if}
</div>
