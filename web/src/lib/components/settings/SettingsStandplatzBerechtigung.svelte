<script lang="ts">
  /**
   * Warum dieser Rechner nicht ferngesteuert werden kann — mit dem Weg zur
   * richtigen Systemeinstellung.
   *
   * **Nicht zu verwechseln mit `SettingsStandplatzFreigabe`**: das ist die
   * Liste, WER diesen Rechner steuern darf. Hier geht es darum, ob er es
   * ueberhaupt KANN — eine Frage an das Betriebssystem, nicht an den Server.
   *
   * Eigene Komponente, weil sie nur anzeigt und nichts entscheidet: den Text
   * baut `lib/remote/freigabeText.ts` (rein und getestet), den Grund liefert
   * der Sidecar. Hier steht bewusst keine Fallunterscheidung.
   */
  import { freigabeHinweis } from '$lib/remote/freigabeText';
  import { stream } from '$lib/stream/state.svelte';

  const hinweis = $derived(freigabeHinweis(stream.fernsteuerbarGrund));
</script>

{#if hinweis}
  <div class="border-border rounded-2xl border p-4 text-sm">
    <p class="text-text font-medium">{hinweis.ueberschrift}</p>
    <p class="text-text-muted mt-1">{hinweis.erklaerung}</p>
    {#if hinweis.pfad}
      <p class="text-text-muted mt-2 font-mono text-xs">{hinweis.pfad}</p>
    {/if}
  </div>
{/if}
