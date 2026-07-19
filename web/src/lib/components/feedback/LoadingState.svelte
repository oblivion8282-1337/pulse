<!--
  „Wird geladen" — für Bereiche, die ihre Daten noch holen.

  Ersetzt vier nebeneinander gewachsene Sprachen: eine reine Textzeile (17
  Stellen, selbst in drei Größen/Tokens), einen Spinner (vier Größen und drei
  verschiedene Icons), ein Skeleton (2 Stellen ohne gemeinsame Komponente) und
  Buttons, die stumm ihre Beschriftung wechseln.

  Nicht abgedeckt und bewusst so gelassen: der Beschriftungswechsel IM Button
  (`{saving ? … : …}`). Der gehört zum Button, nicht in eine eigene Fläche —
  dafür bräuchte die Button-Komponente einen `loading`-Zustand. Siehe
  `docs/2026-07-19-design-vereinheitlichung-bestandsaufnahme.md`.

  Zwei Dichten, analog zu EmptyState:
    * `density="compact"` (Vorgabe) — eine Zeile mit kleinem Spinner, für
      Listen und Abschnitte.
    * `density="page"` — mittig auf einer ganzen Fläche.

      <LoadingState />
      <LoadingState density="page" label={m.stream_connecting()} />
-->
<script lang="ts">
  import LoaderIcon from '@lucide/svelte/icons/loader';
  import * as m from '$lib/paraglide/messages';

  let {
    label = undefined,
    density = 'compact',
    class: extraClass = '',
    testId = undefined
  }: {
    /** Text neben dem Spinner. Fehlt er, bleibt nur der Spinner (mit aria-Label). */
    label?: string;
    density?: 'compact' | 'page';
    class?: string;
    /** Wird als `data-testid` durchgereicht (Testids bleiben beim Umbau gleich). */
    testId?: string;
  } = $props();

  // Nur wenn KEIN sichtbarer Text da ist, braucht es eine eigene Ansage. Sonst
  // läse ein Screenreader innerhalb des `role="status"` beides vor ("Wird
  // geladen … Wird geladen …").
</script>

{#if density === 'page'}
  <div
    class="text-text-muted flex flex-col items-center justify-center gap-3 px-4 py-10 {extraClass}"
    role="status"
    data-testid={testId}
  >
    <LoaderIcon class="size-7 motion-safe:animate-spin" aria-hidden="true" />
    {#if label}
      <p class="text-sm">{label}</p>
    {:else}
      <span class="sr-only">{m.feedback_loading()}</span>
    {/if}
  </div>
{:else}
  <div
    class="text-text-muted flex items-center gap-2 px-3 py-2 text-sm {extraClass}"
    role="status"
    data-testid={testId}
  >
    <LoaderIcon class="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
    {#if label}
      <span>{label}</span>
    {:else}
      <span class="sr-only">{m.feedback_loading()}</span>
    {/if}
  </div>
{/if}
