<!--
  StreamPanel — die HQ-Stream-UI (GSR), eingebettet im Voice-Channel-View
  (HqStreamDialog → StreamPanel). Immer Channel-Modus: gestreamt wird in den
  aktuellen Voice-Channel (per-Channel MediaMTX-Pfad `channel-<id>`, Token vom
  chat-gateway). Capture: Linux über das Wayland-Portal (Portal-Dialog wählt
  die Quelle), Windows über den `MonitorPicker` (WGC hat keinen Portal-Dialog).
  Kein Server-/Profil-Picker mehr — nur Codec/Auflösung/Bitrate/FPS + Audio.

  Gating:
  - `gsr.available()` false → komplett ausblenden (reiner Browser, keine
    Electron-Sidecar-Bridge).
  - Bridge da aber `health.gsr.available` false → "GSR nicht verfügbar"-Banner
    statt Controls (einmalig via `gsr.health()` beim Mount geprüft).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import RocketIcon from '@lucide/svelte/icons/rocket';

  import { isWindows, isMac } from '$lib/platform/runtime';
  import { gsr, type GsrHealth } from '../gsr';
  import { loadCatalogs, setCaptureSourceForSlot, streamSettings } from '../settings.svelte';

  import { m } from '$lib/paraglide/messages.js';
  import OverridesEditor from './OverridesEditor.svelte';
  import MonitorPicker from './MonitorPicker.svelte';
  import AudioModePicker from './AudioModePicker.svelte';
  import AvOffsetSlider from './AvOffsetSlider.svelte';
  import StreamControls from './StreamControls.svelte';
  import StreamLog from './StreamLog.svelte';

  let {
    channelId = null,
    // `slot` is a reserved Svelte attribute name → prop is `streamSlot`.
    streamSlot: slot = 0,
    onStarted,
  }: { channelId?: string | null; streamSlot?: number; onStarted?: () => void } = $props();

  // Hat diese Plattform eine In-App-Quellenauswahl? Windows (WGC) und macOS
  // (SCK) ja — dort wählt der User Bildschirm/Fenster hier im Dialog. Linux
  // nicht: die Quelle bestimmt der Wayland-Portal-Dialog erst beim Start.
  //
  // Das entscheidet zugleich über das Layout: nur mit Quellenauswahl lohnt die
  // zweite Spalte. Sie war der Grund, warum der Dialog auf Windows so lang
  // wurde — Quellenraster PLUS alle Einstellungen untereinander in einer
  // 672-px-Spalte. Ohne Auswahl (Linux) bleibt alles wie bisher einspaltig.
  const hasSourcePicker = isWindows() || isMac();

  let health = $state<GsrHealth | null>(null);
  let healthError = $state<string | null>(null);

  onMount(() => {
    // Always stream into the current voice channel; the codec/resolution/
    // bitrate/fps come straight from the editor below ("Custom" profile = use
    // the explicit values). Capture source: Linux uses the Wayland portal;
    // Windows + macOS resolve a concrete monitor in `loadCatalogs()` (a
    // persisted choice is honoured), so don't clobber it here.
    if (!hasSourcePicker) setCaptureSourceForSlot(slot, 'portal');
    streamSettings.profile_name = 'Custom';
    streamSettings.use_overrides = true;
    if (!gsr.available()) return;
    void gsr.health().then((h) => { health = h; }).catch((e) => { healthError = String(e); });
    void loadCatalogs();
  });

  let gsrAvailable = $derived(!!health?.gsr?.available);
</script>

{#if gsr.available()}
  <section class="glass-panel flex flex-col gap-4 rounded-2xl p-4" data-testid="stream-panel">
    <header class="flex items-center gap-2">
      <RocketIcon class="text-primary size-5" />
      <h2 class="text-text-bright text-base font-semibold tracking-tight">HQ-Stream</h2>
    </header>

    {#if healthError}
      <div
        class="flex items-start gap-2 rounded-md border border-red-700/60 bg-red-950/40 px-3 py-2 text-xs text-red-200"
        role="alert"
        data-testid="stream-panel-bridge-error"
      >
        <AlertTriangleIcon class="mt-0.5 size-4 shrink-0" />
        <span>{m.stream_panel_bridge_error({ error: healthError })}</span>
      </div>
    {:else if health && !gsrAvailable}
      <div
        class="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
        role="alert"
        data-testid="stream-panel-gsr-missing"
      >
        <AlertTriangleIcon class="mt-0.5 size-4 shrink-0" />
        <div class="flex flex-col gap-0.5">
          <span class="font-medium">{m.stream_panel_gsr_unavailable_title()}</span>
          <span>{m.stream_panel_gsr_unavailable_body()}</span>
        </div>
      </div>
    {:else if !channelId}
      <p class="text-text-muted text-xs">
        {m.stream_panel_no_channel_hint()}
      </p>
    {:else}
      {#snippet settingsColumn()}
        <div class="flex min-w-0 flex-col gap-4">
          <OverridesEditor streamSlot={slot} />
          <Separator />
          <AudioModePicker />
          {#if hasSourcePicker}
            <Separator />
            <AvOffsetSlider />
          {/if}
        </div>
      {/snippet}

      <div class="flex flex-col gap-4" data-testid="stream-panel-form">
        {#if hasSourcePicker}
          <!-- Quelle links, Einstellungen rechts. Umbruch auf eine Spalte
               unterhalb von `lg` — in einem schmalen Fenster wären zwei
               Spalten enger als die ursprüngliche eine. -->
          <div class="grid gap-4 lg:grid-cols-2 lg:gap-6">
            <MonitorPicker streamSlot={slot} />
            {@render settingsColumn()}
          </div>
        {:else}
          {@render settingsColumn()}
        {/if}

        <Separator />
        <StreamControls {channelId} streamSlot={slot} {onStarted} />
        <StreamLog streamSlot={slot} />
      </div>
    {/if}
  </section>
{/if}
