<!--
  Dev-Route für die T3b-Streaming-UI.

  Nicht im Menü verlinkt — direkt via `/app/dev/stream` aufzurufen. Rendert
  den produktiven `<StreamPanel />` (gleicher Code wie später im Voice-View)
  plus einen Debug-Block am Fuß mit Raw-Health/buildArgv-Output für E2E-
  Checks. Start öffnet den Wayland-Portal-Dialog — Vorsicht.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { gsr, type GsrHealth, type GsrBuildArgv } from '$lib/stream/gsr';
  import { stream } from '$lib/stream/state.svelte';
  import { buildStartArgs, streamSettings } from '$lib/stream/settings.svelte';
  import StreamPanel from '$lib/stream/components/StreamPanel.svelte';
  import { Button } from '$lib/components/ui/button/index.js';

  let health = $state<GsrHealth | null>(null);
  let argvProbe = $state<GsrBuildArgv | null>(null);
  let argvError = $state<string | null>(null);

  async function refreshHealth() {
    try {
      health = await gsr.health();
    } catch (e) {
      argvError = `health: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function probeBuildArgv() {
    argvError = null;
    argvProbe = null;
    try {
      const r = await gsr.buildArgv(buildStartArgs());
      argvProbe = r;
      if (r && !r.ok) argvError = r.error ?? 'build_argv returned ok=false';
    } catch (e) {
      argvError = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    if (gsr.available()) void refreshHealth();
  });
</script>

<svelte:head><title>Pulse — T3b Stream Dev</title></svelte:head>

<div
  class="text-text-base flex-1 overflow-y-auto p-6"
  data-testid="t3b-stream-dev"
>
  <header class="mb-4">
    <h1 class="text-xl font-semibold">T3b Stream Dev</h1>
    <p class="text-text-muted text-sm">
      Live-Vorschau der Streaming-Components (gleiches Panel wie später im
      Voice-View). <strong class="text-amber-300">Start</strong> öffnet den
      Wayland-Portal-Dialog — nicht aus Versehen klicken.
    </p>
  </header>

  {#if !gsr.available()}
    <div
      class="mb-4 rounded border border-amber-700 bg-amber-950/40 p-3 text-sm"
      data-testid="t3b-stream-dev-browser-notice"
    >
      Kein Electron-Sidecar — Streaming-Panel ist hier ausgeblendet (reiner Browser).
    </div>
  {/if}

  <div class="max-w-2xl">
    <StreamPanel />
  </div>

  <section class="mt-8 max-w-2xl border-t border-border pt-4">
    <h2 class="text-text-bright mb-2 text-sm font-semibold">Debug</h2>
    <div class="mb-2 flex gap-2">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onclick={probeBuildArgv}
        data-testid="t3b-build-argv"
      >
        build_argv (kein Start)
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onclick={refreshHealth}
        data-testid="t3b-refresh-health"
      >
        health refresh
      </Button>
    </div>

    {#if argvError}
      <pre
        class="mb-2 max-h-32 overflow-y-auto rounded bg-red-950/40 p-2 text-[11px] text-red-200">{argvError}</pre>
    {/if}

    <details class="mb-2">
      <summary class="text-text-muted cursor-pointer text-xs">Selections (settings)</summary>
      <pre
        class="mt-1 max-h-64 overflow-y-auto rounded bg-black/40 p-2 text-[11px]">{JSON.stringify(
          {
            profile_name: streamSettings.profile_name,
            server_name: streamSettings.server_name,
            capture_source: streamSettings.capture_source,
            audio_mode: streamSettings.audio_mode,
            excluded_apps: streamSettings.excluded_apps,
            use_overrides: streamSettings.use_overrides,
            overrides: streamSettings.overrides,
          },
          null,
          2,
        )}</pre>
    </details>

    <details class="mb-2">
      <summary class="text-text-muted cursor-pointer text-xs">Last build_argv</summary>
      <pre
        class="mt-1 max-h-64 overflow-y-auto rounded bg-black/40 p-2 text-[11px]">{argvProbe
          ? JSON.stringify(argvProbe, null, 2)
          : '(noch nichts)'}</pre>
    </details>

    <details class="mb-2">
      <summary class="text-text-muted cursor-pointer text-xs">Live state</summary>
      <pre
        class="mt-1 max-h-32 overflow-y-auto rounded bg-black/40 p-2 text-[11px]">{JSON.stringify(
          {
            available: stream.available,
            running: stream.running,
            state: stream.state,
            fps: stream.fps,
            uptimeS: stream.uptimeS,
            error: stream.error,
          },
          null,
          2,
        )}</pre>
    </details>

    <details>
      <summary class="text-text-muted cursor-pointer text-xs">Health (raw)</summary>
      <pre
        class="mt-1 max-h-96 overflow-y-auto rounded bg-black/40 p-2 text-[11px]">{health
          ? JSON.stringify(health, null, 2)
          : '(noch nichts abgefragt)'}</pre>
    </details>
  </section>
</div>
