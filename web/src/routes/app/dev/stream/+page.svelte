<!--
  T3a debug page — bring the GSR sidecar bridge to life from the WebView.

  Not linked from any menu; reach it via URL only. The proper streaming UI
  lands in T3b — this page exists purely to exercise the Rust↔sidecar bridge
  end-to-end without us building production chrome around it.

  Pressing "Start" hands the sidecar a real `gpu-screen-recorder` argv and
  opens the Wayland portal — only do that when you actually want to stream.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { gsr, type GsrHealth, type GsrListMonitors, type GsrListProfiles, type GsrStartArgs } from '$lib/stream/gsr';
  import { stream } from '$lib/stream/state.svelte';

  let health = $state<GsrHealth | null>(null);
  let monitors = $state<GsrListMonitors | null>(null);
  let profiles = $state<GsrListProfiles | null>(null);
  let probeError = $state<string | null>(null);
  let starting = $state(false);
  let stopping = $state(false);

  // Form selection
  let profileName = $state('AV1 Effizient');
  let serverName = $state('Hetzner');
  let captureSource = $state('portal');
  let audioMode = $state('Desktop');

  async function refresh() {
    probeError = null;
    try {
      health = await gsr.health();
      monitors = await gsr.listMonitors();
      profiles = await gsr.listProfiles();
      if (profiles && profiles.profiles.length > 0) {
        // Pick a sane default if the current selection isn't valid.
        if (!profiles.profiles.find((p) => p.name === profileName)) {
          profileName = profiles.profiles[0].name;
        }
        if (profiles.servers.length > 0 && !profiles.servers.find((s) => s.name === serverName)) {
          serverName = profiles.servers[0].name;
        }
      }
    } catch (e) {
      probeError = String(e);
    }
  }

  onMount(() => {
    if (!gsr.available()) {
      probeError = 'Not running under Tauri — the GSR bridge is disabled.';
      return;
    }
    void refresh();
  });

  function startArgs(): GsrStartArgs {
    return {
      profile: profileName,
      server: serverName,
      capture: captureSource,
      audio: { mode: audioMode, excluded_apps: [] },
      stream_key: 'PLACEHOLDER',
    };
  }

  async function doStart() {
    starting = true;
    try {
      const r = await gsr.start(startArgs());
      if (r && !r.ok) probeError = r.error ?? 'start returned ok=false';
    } catch (e) {
      probeError = String(e);
    } finally {
      starting = false;
    }
  }

  async function doStop() {
    stopping = true;
    try {
      await gsr.stop();
    } catch (e) {
      probeError = String(e);
    } finally {
      stopping = false;
    }
  }

  async function doBuildArgv() {
    try {
      const r = await gsr.buildArgv(startArgs());
      probeError = r ? null : 'no response';
      // Display via the log channel so the user sees the assembled argv.
      if (r?.argv) {
        // eslint-disable-next-line no-console
        console.log('build_argv →', r.argv.join(' '));
      }
      // also stash it into the in-page error field for visibility when
      // devtools aren't open
      if (r?.argv) probeError = `(build_argv) ${r.argv.join(' ')}`;
      else if (r?.error) probeError = `(build_argv) ${r.error}`;
    } catch (e) {
      probeError = String(e);
    }
  }
</script>

<svelte:head><title>Pulse — T3a Stream Debug</title></svelte:head>

<div class="text-text-base flex-1 overflow-y-auto p-6" data-testid="t3a-stream-debug">
  <header class="mb-4">
    <h1 class="text-xl font-semibold">T3a Stream Debug</h1>
    <p class="text-text-muted text-sm">
      Direkter Draht zum <code class="rounded bg-black/20 px-1">gsr-sidecar</code> via Tauri.
      <strong class="text-amber-300">Start</strong> öffnet den Wayland-Portal-Dialog und kann
      tatsächlich an MediaMTX pushen — nicht aus Versehen klicken.
    </p>
  </header>

  {#if probeError}
    <div class="mb-4 rounded border border-amber-700 bg-amber-950/40 p-3 font-mono text-sm">
      {probeError}
    </div>
  {/if}

  <section class="mb-6">
    <h2 class="mb-2 text-lg font-medium">Status</h2>
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-sm">
      <dt>available</dt><dd>{stream.available}</dd>
      <dt>state</dt><dd>{stream.state}</dd>
      <dt>running</dt><dd>{stream.running}</dd>
      <dt>fps</dt><dd>{stream.fps ?? '—'}</dd>
      <dt>uptime_s</dt><dd>{stream.uptimeS ?? '—'}</dd>
      <dt>error</dt><dd class:text-red-400={stream.error}>{stream.error ?? '—'}</dd>
    </dl>
  </section>

  <section class="mb-6">
    <h2 class="mb-2 text-lg font-medium">Auswahl</h2>
    <div class="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2 text-sm">
      <label for="profile">Profil</label>
      <select id="profile" bind:value={profileName} class="rounded bg-black/30 px-2 py-1">
        {#each profiles?.profiles ?? [] as p}
          <option value={p.name}>{p.name} ({p.codec}, {p.bitrate_kbps}k, {p.fps}fps)</option>
        {/each}
      </select>

      <label for="server">Server</label>
      <select id="server" bind:value={serverName} class="rounded bg-black/30 px-2 py-1">
        {#each profiles?.servers ?? [] as s}
          <option value={s.name}>{s.name} ({s.push_protocol}://{s.push_host}:{s.push_port})</option>
        {/each}
      </select>

      <label for="capture">Capture</label>
      <select id="capture" bind:value={captureSource} class="rounded bg-black/30 px-2 py-1">
        <option value="portal">portal (Wayland-Portal — interaktive Auswahl)</option>
        {#each monitors?.monitors ?? [] as m}
          <option value={m.name}>{m.name} ({m.resolution})</option>
        {/each}
      </select>

      <label for="audio">Audio-Modus</label>
      <select id="audio" bind:value={audioMode} class="rounded bg-black/30 px-2 py-1">
        {#each profiles?.audio_modes ?? ['Aus', 'Desktop'] as a}
          <option value={a}>{a}</option>
        {/each}
      </select>
    </div>
  </section>

  <section class="mb-6 flex gap-2">
    <button type="button" onclick={refresh} class="rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600">
      Reload health/monitors/profiles
    </button>
    <button type="button" onclick={doBuildArgv} class="rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600">
      build_argv (kein Start)
    </button>
    <button
      type="button"
      onclick={doStart}
      disabled={starting || stream.running}
      class="rounded bg-emerald-700 px-3 py-1.5 text-sm hover:bg-emerald-600 disabled:opacity-50"
    >
      {starting ? 'Starting…' : 'Start'}
    </button>
    <button
      type="button"
      onclick={doStop}
      disabled={stopping || !stream.running}
      class="rounded bg-red-700 px-3 py-1.5 text-sm hover:bg-red-600 disabled:opacity-50"
    >
      {stopping ? 'Stopping…' : 'Stop'}
    </button>
  </section>

  <section class="mb-6">
    <h2 class="mb-2 text-lg font-medium">Log (letzte 10)</h2>
    <pre class="max-h-64 overflow-y-auto rounded bg-black/40 p-2 text-xs">{stream.lastLog
        .slice(-10)
        .join('\n') || '(noch nichts)'}</pre>
  </section>

  <section>
    <h2 class="mb-2 text-lg font-medium">Health-Response (raw)</h2>
    <pre class="max-h-96 overflow-y-auto rounded bg-black/40 p-2 text-xs">{health ? JSON.stringify(health, null, 2) : '(noch nicht abgefragt — Tauri nötig)'}</pre>
  </section>
</div>
