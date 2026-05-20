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
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import {
    streamSettings,
    persistSettings,
    refreshMonitors,
    MONITOR_CAPTURE_PREFIX,
  } from '../settings.svelte';

  let refreshing = $state(false);

  function onPick(e: Event) {
    streamSettings.capture_source = (e.currentTarget as HTMLSelectElement).value;
    persistSettings();
  }

  async function onRefresh() {
    refreshing = true;
    try {
      await refreshMonitors();
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="flex flex-col gap-2" data-testid="stream-monitor-picker">
  <div class="flex items-center justify-between">
    <Label for="stream-monitor-select">Bildschirm</Label>
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onclick={onRefresh}
      disabled={refreshing}
      aria-label="Bildschirm-Liste neu laden"
      data-testid="stream-monitor-refresh"
    >
      <RefreshIcon class="size-3 {refreshing ? 'animate-spin' : ''}" />
      Refresh
    </Button>
  </div>

  {#if streamSettings.available_monitors.length === 0}
    <p class="text-text-muted text-xs italic" data-testid="stream-monitor-empty">
      (keine Bildschirme erkannt — Refresh klicken; gestreamt wird der Primärmonitor)
    </p>
  {:else}
    <select
      id="stream-monitor-select"
      class="bg-bg-chat text-text-base h-8 rounded-md px-2 text-xs outline-none"
      value={streamSettings.capture_source}
      onchange={onPick}
      data-testid="stream-monitor-select"
    >
      {#each streamSettings.available_monitors as mon (mon.index)}
        <option value={`${MONITOR_CAPTURE_PREFIX}${mon.index}`}>
          Bildschirm {mon.index}: {mon.name}{mon.primary ? ' (primär)' : ''}{mon.width
            ? ` — ${mon.width}×${mon.height}`
            : ''}
        </option>
      {/each}
    </select>
  {/if}
</div>
