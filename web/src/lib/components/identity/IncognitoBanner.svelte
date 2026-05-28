<script lang="ts">
  /**
   * Inkognito/Private-Browsing-Banner.
   *
   * Zeigt einen harten Warning-Banner wenn der Browser im Inkognito-Modus
   * läuft oder Storage nicht persistent ist. Relevant für das Cert-Modell
   * (DE 11 A.1): der private Ed25519-Schlüssel liegt in IndexedDB — im
   * Inkognito-Modus wird er beim Tab-Schließen gelöscht.
   *
   * Usage:
   *   <IncognitoBanner />          — prüft selbst beim Mount
   *   <IncognitoBanner show={true} /> — direkt anzeigen (für Tests)
   */

  import { onMount } from 'svelte';
  import { getPrivateBrowsingState } from '$lib/identity/private-browsing';

  let { show = undefined }: { show?: boolean } = $props();

  let detected = $state(false);
  let checked = $state(false);

  onMount(async () => {
    if (show !== undefined) {
      detected = show;
      checked = true;
      return;
    }
    detected = await getPrivateBrowsingState();
    checked = true;
  });
</script>

{#if checked && detected}
  <div
    role="alert"
    class="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    data-testid="incognito-banner"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="mt-0.5 size-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <div class="flex flex-col gap-0.5">
      <strong class="font-semibold">Privater Browser erkannt</strong>
      <span class="text-destructive/80">
        Dein Geräte-Schlüssel wird im privaten Modus nach dem Schließen des Tabs gelöscht.
        Öffne Pulse in einem normalen Browser-Fenster, damit dein Geräte-Zertifikat erhalten bleibt.
      </span>
    </div>
  </div>
{/if}
