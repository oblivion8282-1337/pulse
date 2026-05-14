<!--
  StreamPanel — die HQ-Stream-UI (GSR), eingebettet im Voice-Channel-View
  (HqStreamDialog → StreamPanel). Immer Channel-Modus: gestreamt wird in den
  aktuellen Voice-Channel (per-Channel MediaMTX-Pfad `channel-<id>`, Token vom
  chat-gateway), Capture immer über das Wayland-Portal. Kein Server-/Profil-/
  Capture-Picker mehr — nur Codec/Auflösung/Bitrate/FPS + Audio.

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

  import { gsr, type GsrHealth } from '../gsr';
  import { loadCatalogs, streamSettings } from '../settings.svelte';

  import OverridesEditor from './OverridesEditor.svelte';
  import AudioModePicker from './AudioModePicker.svelte';
  import StreamControls from './StreamControls.svelte';
  import StreamLog from './StreamLog.svelte';

  let { channelId = null }: { channelId?: string | null } = $props();

  let health = $state<GsrHealth | null>(null);
  let healthError = $state<string | null>(null);

  onMount(() => {
    // Always stream into the current voice channel via the portal; the
    // codec/resolution/bitrate/fps come straight from the editor below
    // ("Custom" profile = use the explicit values).
    streamSettings.capture_source = 'portal';
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
        <span>Bridge-Fehler: {healthError}</span>
      </div>
    {:else if health && !gsrAvailable}
      <div
        class="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
        role="alert"
        data-testid="stream-panel-gsr-missing"
      >
        <AlertTriangleIcon class="mt-0.5 size-4 shrink-0" />
        <div class="flex flex-col gap-0.5">
          <span class="font-medium">Streaming-Binary nicht verfügbar.</span>
          <span>Die Pulse-Desktop-App konnte den Encoder nicht finden.</span>
        </div>
      </div>
    {:else if !channelId}
      <p class="text-text-muted text-xs">
        Öffne den HQ-Stream aus einem Sprach-Kanal — dorthin wird gestreamt.
      </p>
    {:else}
      <div class="flex flex-col gap-4" data-testid="stream-panel-form">
        <OverridesEditor />

        <Separator />
        <AudioModePicker />

        <Separator />
        <StreamControls {channelId} />
        <StreamLog />
      </div>
    {/if}
  </section>
{/if}
