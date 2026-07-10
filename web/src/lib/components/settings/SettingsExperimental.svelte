<!--
  SettingsExperimental — „Experimental"-Tab (nur Linux-Desktop, siehe
  SettingsDialog `linuxOnly`).

  Aktuell ein Schalter: den neuen Rust-Linux-HQ-Sidecar statt des Python-GSR-
  Sidecars verwenden. Der Wert liegt im Electron-Store (`useRustSidecar`), den
  der Main-Prozess beim Sidecar-Spawn liest (`sidecar.ts::resolveSidecarSpawn`).
  Beim Umschalten startet der Main die (idle) Sidecar-Prozesse neu, sodass die
  Änderung beim nächsten Stream greift — ohne Pulse-Neustart.

  Wichtig: Solange dieser Schalter an ist, werden Diagnose-Logs zur Fehlersuche
  hochgeladen (der bewusste Opt-in dafür). Das steht als Hinweis klar am Toggle.
-->
<script lang="ts">
  import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';

  let enabled = $state(false);
  let ready = $state(false);

  onMount(async () => {
    try {
      const v = await window.pulse?.store.get('useRustSidecar');
      enabled = v === true;
    } catch {
      // Store nicht erreichbar (sollte auf dem Desktop nicht passieren) — Default aus.
    }
    ready = true;
  });

  async function onToggle(e: Event) {
    const next = (e.currentTarget as HTMLInputElement).checked;
    enabled = next;
    try {
      await window.pulse?.store.set('useRustSidecar', next);
    } catch {
      // Persistenz fehlgeschlagen → optimistisches UI zurücksetzen.
      enabled = !next;
    }
  }
</script>

<div class="flex flex-col gap-5" data-testid="settings-experimental-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright flex items-center gap-2 text-lg font-semibold">
      <FlaskConicalIcon class="size-5" />
      {m.settings_experimental_heading()}
    </h2>
    <p class="text-text-muted text-sm">{m.settings_experimental_intro()}</p>
  </div>

  <!-- Rust-Sidecar-Toggle -->
  <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
    <label class="flex items-start gap-3">
      <input
        type="checkbox"
        class="accent-primary mt-0.5 size-4 shrink-0"
        checked={enabled}
        disabled={!ready}
        onchange={onToggle}
        data-testid="experimental-rust-sidecar-toggle"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">
          {m.settings_experimental_rust_sidecar_label()}
        </span>
        <span class="text-text-muted text-xs">
          {m.settings_experimental_rust_sidecar_desc()}
        </span>
      </span>
    </label>

    <!-- Diagnose-Log-Hinweis (der Opt-in für den Upload) -->
    <p class="text-text-muted border-border/60 border-t pt-3 text-xs">
      {m.settings_experimental_logs_notice()}
    </p>
  </div>
</div>
