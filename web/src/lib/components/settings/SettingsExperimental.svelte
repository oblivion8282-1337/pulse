<!--
  SettingsExperimental — „Experimental"-Tab (jede Desktop-App, siehe
  SettingsDialog `electronOnly`).

  **Der Tab-Name wanderte zweimal:** bis 2026-08-06 hieß er „Kompatibilität",
  danach kurz „Diagnose", seit 2026-08-06 „Experimental". Die Datei und der
  Übersetzungsschlüssel `settings_dialog_tab_diagnostics` tragen den mittleren
  Namen teils noch — der Schlüssel bleibt bewusst stehen, ein Umbenennen von
  Schlüsseln zieht nur Konflikte in den Übersetzungsdateien nach sich, ohne
  dass ein Nutzer etwas davon hätte.

  **Auf Linux beschränkt war er bis 2026-08-06 ebenfalls.** Das
  stammte aus der Zeit, als der Tab nur den Rust-Linux-Sidecar umschaltete —
  mit dem Diagnose-Schalter darin war es ein stiller Ausschluss: Windows- und
  macOS-Nutzer sahen den Tab nicht, konnten die Einwilligung also gar nicht
  geben, und es kam nie ein Bericht von dort an. Der Upload-Weg selbst war die
  ganze Zeit plattformneutral.

  Übrig ist DIAGNOSEBERICHTE senden (`uploadDiagnosticLogs`, default aus) — ein
  eigener Opt-in, auf jeder Plattform. Begründung in
  `desktop/electron/experimental-log-upload.ts`.

  **Das Aufnahme-Verfahren stand bis 2026-08-16 hier**: eine Statuszeile (Rust
  oder GSR) und eine Notbremse zurück auf den älteren Python/GSR-Sidecar. Beides
  ist weg, weil die Wahl keine mehr ist — der Rust-Sidecar ist unter Linux der
  Weg, GSR nur noch das automatische Auffangnetz, wenn das Rust-Binary fehlt
  (`sidecar.ts::resolveLinuxSpawn`). Ein Schalter, der auf ein Auffangnetz
  zurückstellt, lädt zum Ausprobieren ein und beantwortet keine Frage, die ein
  Nutzer hat. Der GSR-Weg selbst bleibt geparkt; wer ihn zum Messen braucht,
  setzt `PULSE_LEGACY_GSR=1`.
-->
<script lang="ts">
  import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';

  // Vorbelegung: an. Wird in `onMount` durch den gespeicherten Wert ersetzt;
  // bis dahin soll das Haekchen nicht faelschlich leer aussehen.
  let uploadLogs = $state(true);
  let ready = $state(false);

  onMount(async () => {
    try {
      const upload = await window.pulse?.store.get('uploadDiagnosticLogs');
      // Standard AN seit 2026-08-06: nur ein ausdrueckliches `false` haelt
      // das Haekchen leer. Fehlender Schluessel = frische oder unberuehrte
      // Installation = an. Muss zur Lesart in `experimental-log-upload.ts`
      // passen, sonst zeigt die Oberflaeche etwas anderes, als der Client tut.
      uploadLogs = upload !== false;
    } catch {
      // Store nicht erreichbar (sollte auf dem Desktop nicht passieren) — Defaults.
    }
    ready = true;
  });

  // Setzt optimistisch und rollt bei Persistenz-Fehler zurück.

  async function onToggleUpload(e: Event): Promise<void> {
    const next = (e.currentTarget as HTMLInputElement).checked;
    uploadLogs = next;
    try {
      await window.pulse?.store.set('uploadDiagnosticLogs', next);
    } catch {
      uploadLogs = !next;
    }
  }

</script>

<div class="flex flex-col gap-5" data-testid="settings-experimental-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-text-bright flex items-center gap-2 text-base font-semibold">
      <PlugZapIcon class="size-5" />
      {m.settings_diag_heading()}
    </h2>
    <p class="text-text-muted text-xs">{m.settings_diag_intro()}</p>
  </div>

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
