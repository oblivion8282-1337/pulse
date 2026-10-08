<!--
  Sperrfläche der App (iOS-Liste Punkt 42).

  **Deckend, und zwar absichtlich** — anders als der Verbindungs-Hinweis, der
  nur ein Streifen ist. Eine Sperre, durch die man den Inhalt lesen kann, ist
  keine Sperre; hier ist das Verdecken die ganze Funktion.

  **Die Abfrage läuft von selbst an**, nicht erst auf Knopfdruck: wer die App
  öffnet, will hinein, und ein zusätzlicher Tipp wäre ein Tipp zu viel. Der
  Knopf darunter ist für den zweiten Versuch — Face ID erkennt nicht immer
  beim ersten Mal, und ein weggetippter Dialog darf keine Sackgasse sein.

  **Ein Abbruch ist keine Fehlermeldung.** Wer die Abfrage wegtippt, hat nicht
  falsch geantwortet, sondern nicht geantwortet. Dann steht hier weiter die
  Sperre mit dem Erneut-Knopf, nichts Rotes.

  Was die Sperre NICHT ist: Schutz der Daten vor jemandem, der das Gerät hat.
  Der lokale Verlauf liegt in der IndexedDB und hängt am Dateischutz des
  Containers, nicht an dieser Abfrage. Begründung samt der Entscheidung „nur
  beim Neustart" in `platform/appSperre.svelte.ts`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import LockIcon from '@lucide/svelte/icons/lock';
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';
  import { appSperre } from '$lib/platform/appSperre.svelte';

  onMount(() => {
    void appSperre.entsperren(m.appsperre_text());
  });
</script>

{#if appSperre.gesperrt}
  <div
    class="bg-bg-base fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 px-8 text-center"
    role="dialog"
    aria-modal="true"
    aria-label={m.appsperre_titel()}
    data-testid="app-sperre"
  >
    <div
      class="bg-primary/15 text-primary flex size-16 items-center justify-center rounded-full"
    >
      <LockIcon class="size-7" />
    </div>
    <h1 class="text-text text-lg font-semibold">{m.appsperre_titel()}</h1>
    <p class="text-text-muted max-w-xs text-sm">{m.appsperre_text()}</p>
    {#if appSperre.fehler}
      <p class="text-destructive max-w-xs text-sm" data-testid="app-sperre-fehler">
        {appSperre.fehler}
      </p>
    {/if}
    <Button
      class="min-h-12 w-full max-w-xs"
      disabled={appSperre.laeuft}
      onclick={() => void appSperre.entsperren(m.appsperre_text())}
      data-testid="app-sperre-entsperren"
    >
      {appSperre.laeuft ? m.appsperre_laeuft() : m.appsperre_knopf()}
    </Button>
  </div>
{/if}
