<!--
  StreamPanel — die ganze Streaming-UI als Composite.

  Wird in T3c im Voice-Channel-View eingebettet. Hier in T3b: in der
  Dev-Route nutzbar. Layout: Profil/Server/Capture/Audio → Overrides
  (collapsible) → Controls → Log.

  Gating:
  - `gsr.available()` false → komplett ausblenden (Browser ohne Tauri).
  - `stream.available` true aber `health.gsr.available` false →
    "GSR nicht verfügbar"-Banner statt Controls. Wir prüfen das beim Mount
    einmalig via `gsr.health()`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';

  import { gsr, type GsrHealth } from '../gsr';
  import { stream } from '../state.svelte';
  import { loadCatalogs, streamSettings, isCustomProfile } from '../settings.svelte';

  import ProfilePicker from './ProfilePicker.svelte';
  import ServerPicker from './ServerPicker.svelte';
  import CaptureSourcePicker from './CaptureSourcePicker.svelte';
  import AudioModePicker from './AudioModePicker.svelte';
  import OverridesEditor from './OverridesEditor.svelte';
  import StreamControls from './StreamControls.svelte';
  import StreamLog from './StreamLog.svelte';

  let health = $state<GsrHealth | null>(null);
  let healthError = $state<string | null>(null);
  let healthChecking = $state(false);
  let overridesOpen = $derived(streamSettings.use_overrides || isCustomProfile());

  async function checkHealth() {
    healthChecking = true;
    healthError = null;
    try {
      health = await gsr.health();
    } catch (e) {
      healthError = e instanceof Error ? e.message : String(e);
    } finally {
      healthChecking = false;
    }
  }

  onMount(() => {
    if (!gsr.available()) return;
    void checkHealth();
    void loadCatalogs();
  });

  let gsrAvailable = $derived(!!health?.gsr?.available);
  let codecCount = $derived(health?.gsr?.video_codecs?.length ?? null);

  function toggleOverrides() {
    streamSettings.use_overrides = !streamSettings.use_overrides;
  }
</script>

{#if gsr.available()}
  <section
    class="glass-panel flex flex-col gap-4 rounded-2xl p-4"
    data-testid="stream-panel"
  >
    <header class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <RadioTowerIcon class="text-primary size-5" />
        <h2 class="text-text-bright text-base font-semibold tracking-tight">
          HQ-Stream
        </h2>
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onclick={() => {
          void checkHealth();
          void loadCatalogs();
        }}
        disabled={healthChecking}
        aria-label="Neu prüfen"
        data-testid="stream-panel-refresh"
      >
        <RefreshIcon class="size-3.5 {healthChecking ? 'animate-spin' : ''}" />
      </Button>
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
          <span class="font-medium">
            <code class="bg-bg-input rounded px-1">gpu-screen-recorder</code> nicht verfügbar.
          </span>
          <span>Installiere das Binary oder setze <code>GSR_BINARY</code>.</span>
        </div>
      </div>
    {:else}
      <div class="flex flex-col gap-4" data-testid="stream-panel-form">
        <ProfilePicker />
        <ServerPicker />
        <CaptureSourcePicker />
        <AudioModePicker />

        <Separator />

        <div class="flex flex-col gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="w-fit gap-1.5"
            onclick={toggleOverrides}
            aria-expanded={overridesOpen}
            disabled={isCustomProfile()}
            data-testid="stream-panel-overrides-toggle"
          >
            {#if overridesOpen}<ChevronDownIcon class="size-3.5" />
            {:else}<ChevronRightIcon class="size-3.5" />{/if}
            Manuelle Overrides
            {#if isCustomProfile()}
              <span class="text-text-muted text-xs">(Custom-Profil aktiv)</span>
            {/if}
          </Button>
          {#if overridesOpen}
            <OverridesEditor />
          {/if}
        </div>

        <Separator />
        <StreamControls />
        <StreamLog />
      </div>
    {/if}

    {#if codecCount}
      <p class="text-text-muted -mt-2 text-[11px]" data-testid="stream-panel-codecs">
        Hardware-Codecs: {health?.gsr?.video_codecs?.join(', ')}
      </p>
    {/if}
  </section>
{/if}
