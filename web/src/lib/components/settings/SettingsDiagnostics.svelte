<!--
  SettingsDiagnostics — „Diagnose"-Tab (jede Desktop-App, siehe SettingsDialog
  `electronOnly`).

  **Hiess bis 2026-08-06 „Kompatibilität" und war auf Linux beschränkt.** Das
  stammte aus der Zeit, als der Tab nur den Rust-Linux-Sidecar umschaltete —
  mit dem Diagnose-Schalter darin war es ein stiller Ausschluss: Windows- und
  macOS-Nutzer sahen den Tab nicht, konnten die Einwilligung also gar nicht
  geben, und es kam nie ein Bericht von dort an. Der Upload-Weg selbst war die
  ganze Zeit plattformneutral.

  Drei Dinge, bewusst getrennt:

   1. DIAGNOSEBERICHTE senden (`uploadDiagnosticLogs`, default aus) — ein
      EIGENER Opt-in, auf jeder Plattform. Begründung in
      `desktop/electron/experimental-log-upload.ts`.

   2. ANZEIGE, welches Aufnahme-Verfahren gerade läuft — inklusive des
      automatischen Rückfalls auf GSR (`sidecar.ts::resolveLinuxSpawn`), den
      der Tab sonst niemandem verriete. Nur unter Linux, weil es nur dort zwei
      Verfahren gibt.

   3. NOTBREMSE zurück auf GSR (`useLegacyGsrSidecar`, default aus). Beim
      Umschalten startet der Main die (idle) Sidecar-Prozesse neu, sodass es
      beim nächsten Stream greift — ohne Pulse-Neustart. Ebenfalls nur Linux:
      auf Windows/macOS gibt es keinen GSR-Sidecar, auf den man zurückfallen
      könnte, und der Schalter wäre eine Zusage, die niemand einlöst.
-->
<script lang="ts">
  import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import type { PulseLinuxBackend } from '$lib/platform/pulse';
  import { isLinux } from '$lib/platform/runtime';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  let backend = $state<PulseLinuxBackend | null>(null);
  let useLegacy = $state(false);
  let uploadLogs = $state(false);
  let ready = $state(false);

  // Nur unter Linux gibt es zwei Aufnahme-Verfahren — Statuszeile und
  // Notbremse haengen daran, die Diagnoseberichte nicht.
  const isLinuxDesktop = isLinux();

  onMount(async () => {
    try {
      const [legacy, upload] = await Promise.all([
        window.pulse?.store.get('useLegacyGsrSidecar'),
        window.pulse?.store.get('uploadDiagnosticLogs')
      ]);
      useLegacy = legacy === true;
      uploadLogs = upload === true;
    } catch {
      // Store nicht erreichbar (sollte auf dem Desktop nicht passieren) — Defaults.
    }
    if (isLinuxDesktop) await refreshBackend();
    ready = true;
  });

  async function refreshBackend(): Promise<void> {
    try {
      backend = (await window.pulse?.gsr.backend()) ?? null;
    } catch {
      backend = null;
    }
  }

  // Beide Schalter setzen optimistisch und rollen bei Persistenz-Fehler zurück.

  async function onToggleLegacy(e: Event): Promise<void> {
    const next = (e.currentTarget as HTMLInputElement).checked;
    useLegacy = next;
    try {
      await window.pulse?.store.set('useLegacyGsrSidecar', next);
    } catch {
      useLegacy = !next;
    }
    // Der Main hat den Spawn-Cache invalidiert → neu abfragen, damit die
    // Anzeige nicht das alte Verfahren behauptet.
    await refreshBackend();
  }

  async function onToggleUpload(e: Event): Promise<void> {
    const next = (e.currentTarget as HTMLInputElement).checked;
    uploadLogs = next;
    try {
      await window.pulse?.store.set('uploadDiagnosticLogs', next);
    } catch {
      uploadLogs = !next;
    }
  }

  function labelFor(b: PulseLinuxBackend | null): string {
    switch (b?.kind) {
      case 'rust':
        return m.settings_compat_status_rust();
      case 'gsr':
        return m.settings_compat_status_gsr();
      default:
        return m.settings_compat_status_none();
    }
  }

  /** Gelb nur beim ungewollten Rückfall — die bewusste GSR-Wahl ist kein Problem. */
  function toneFor(b: PulseLinuxBackend | null): string {
    if (b?.reason === 'fallback') return 'bg-warning';
    if (b) return 'bg-success';
    return 'bg-text-muted';
  }

  const statusLabel = $derived(labelFor(backend));
  const statusTone = $derived(toneFor(backend));
</script>

<div class="flex flex-col gap-5" data-testid="settings-diagnostics-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright flex items-center gap-2 text-base font-semibold">
      <PlugZapIcon class="size-5" />
      {m.settings_diag_heading()}
    </h2>
    <p class="text-text-muted text-xs">{m.settings_diag_intro()}</p>
  </div>

  <!-- Aufnahme-Verfahren + Notbremse: NUR Linux. Dort gibt es zwei Verfahren
       (Rust und GSR) und damit etwas zu zeigen und umzuschalten; auf
       Windows/macOS gäbe es keinen Rückfall, auf den der Schalter zeigen
       könnte. Der Tab selbst ist seit 2026-08-06 auf allen Plattformen da —
       wegen der Diagnoseberichte weiter unten. -->
  {#if isLinuxDesktop}
  <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
    <div class="flex flex-col gap-1">
      <h3 class="text-text-bright text-sm font-semibold">
        {m.settings_diag_capture_heading()}
      </h3>
      <p class="text-text-muted text-xs">{m.settings_compat_intro()}</p>
    </div>

    <!-- Statuszeile: was läuft gerade? -->
    <div class="flex flex-col gap-1" data-testid="compat-backend-status">
      <span class="flex items-center gap-2 text-sm">
        <span class="size-2 shrink-0 rounded-full {statusTone}"></span>
        <span class="text-text-bright font-medium">{statusLabel}</span>
      </span>
      {#if backend?.reason === 'fallback'}
        <span class="text-text-muted pl-4 text-xs" data-testid="compat-backend-fallback-note">
          {m.settings_compat_status_fallback_note()}
        </span>
      {:else if !backend && ready}
        <span class="text-text-muted pl-4 text-xs">
          {m.settings_compat_status_none_note()}
        </span>
      {/if}
    </div>

    <!-- Notbremse zurück auf GSR -->
    <label class="border-border/60 flex items-start gap-3 border-t pt-3">
      <Checkbox
        class="mt-0.5 shrink-0"
        checked={useLegacy}
        disabled={!ready}
        onchange={onToggleLegacy}
        data-testid="compat-legacy-gsr-toggle"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">
          {m.settings_compat_legacy_label()}
        </span>
        <span class="text-text-muted text-xs">
          {m.settings_compat_legacy_desc()}
        </span>
      </span>
    </label>
  </div>
  {/if}

  <!-- Diagnose-Logs: eigener Opt-in, bewusst als eigenes Feld. Auf JEDER
       Plattform sichtbar — das ist der Punkt der Änderung vom 2026-08-06. -->
  <div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
    <label class="flex items-start gap-3">
      <Checkbox
        class="mt-0.5 shrink-0"
        checked={uploadLogs}
        disabled={!ready}
        onchange={onToggleUpload}
        data-testid="compat-upload-logs-toggle"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">
          {m.settings_compat_logs_label()}
        </span>
        <span class="text-text-muted text-xs">
          {m.settings_compat_logs_desc()}
        </span>
      </span>
    </label>
  </div>
</div>
