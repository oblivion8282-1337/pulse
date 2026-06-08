<script lang="ts">
  /**
   * Generator-Modus fürs Backup-Setup: erzeugt einen starken Wiederherstellungs-
   * Schlüssel (siehe `generateRecoveryKey`) und ERZWINGT einen bewussten Speicher-
   * Schritt — die „gespeichert"-Bestätigung wird erst frei, wenn der User den
   * Schlüssel einmal kopiert oder heruntergeladen hat. Das verhindert das
   * Aussperr-Szenario „generiert, aber nirgends verwahrt" (die Zwischenablage ist
   * flüchtig). Bindet `value` (der Schlüssel = Master-Passwort-Ersatz) und `saved`
   * (Freigabe für den Submit-Button im Eltern-Formular) nach außen.
   */
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import { generateRecoveryKey } from '$lib/identity/key-backup.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    value = $bindable(''),
    saved = $bindable(false),
  }: { value?: string; saved?: boolean } = $props();

  // Beim ersten Mount erzeugen (nur wenn das Eltern-Formular noch keinen hält).
  if (!value) value = generateRecoveryKey();

  let copied = $state(false);
  // Solange weder kopiert noch heruntergeladen, bleibt die Bestätigung gesperrt.
  // Mit `saved` initialisieren: kommt die Komponente nach einem Modus-Wechsel neu
  // (Eltern-State `saved` schon true, weil vorher gesichert), bleibt die Checkbox
  // konsistent gecheckt UND frei statt gecheckt-aber-gesperrt.
  let secured = $state(saved);

  function regenerate() {
    value = generateRecoveryKey();
    saved = false;
    secured = false;
    copied = false;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      secured = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard-API verweigert (kein sicherer Kontext / Permission) →
      // Download bleibt der Weg, den Schlüssel zu sichern.
    }
  }

  function download() {
    const blob = new Blob([m.cloud_backup_generated_key_file_body({ key: value })], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = m.cloud_backup_generated_key_filename();
    a.click();
    URL.revokeObjectURL(url);
    secured = true;
  }
</script>

<div class="flex flex-col gap-3">
  <p class="text-text-muted text-xs">{m.cloud_backup_generated_key_intro()}</p>

  <div class="flex flex-col gap-1">
    <span class="text-text-muted text-xs font-medium">{m.cloud_backup_generated_key_label()}</span>
    <div
      class="border-border bg-bg-input text-text-bright flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5"
    >
      <code class="text-sm font-semibold tracking-wider break-all select-all" data-testid="generated-key"
        >{value}</code
      >
      <button
        type="button"
        onclick={regenerate}
        class="text-text-muted hover:text-text-base shrink-0"
        aria-label={m.cloud_backup_generated_key_regenerate()}
        title={m.cloud_backup_generated_key_regenerate()}
        data-testid="generated-key-regenerate"
      >
        <RefreshCwIcon class="size-4" />
      </button>
    </div>
  </div>

  <div class="flex gap-2">
    <button
      type="button"
      onclick={copy}
      class="border-border bg-bg-input text-text-base hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
      data-testid="generated-key-copy"
    >
      {#if copied}
        <CheckIcon class="size-3.5 text-emerald-500" />{m.cloud_backup_generated_key_copied()}
      {:else}
        <CopyIcon class="size-3.5" />{m.cloud_backup_generated_key_copy()}
      {/if}
    </button>
    <button
      type="button"
      onclick={download}
      class="border-border bg-bg-input text-text-base hover:bg-bg-hover flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
      data-testid="generated-key-download"
    >
      <DownloadIcon class="size-3.5" />{m.cloud_backup_generated_key_download()}
    </button>
  </div>

  <p class="text-amber-500 text-xs">{m.cloud_backup_generated_key_warning()}</p>

  <label
    class="flex items-start gap-2 text-xs {secured
      ? 'text-text-base cursor-pointer'
      : 'text-text-muted cursor-not-allowed opacity-60'}"
  >
    <input
      type="checkbox"
      bind:checked={saved}
      disabled={!secured}
      class="mt-0.5"
      data-testid="generated-key-saved-checkbox"
    />
    <span>{m.cloud_backup_generated_key_saved_confirm()}</span>
  </label>
</div>
