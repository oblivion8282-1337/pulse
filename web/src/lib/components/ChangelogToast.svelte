<!--
  ChangelogToast: rendert die neuen Changelog-Einträge als Inhalt eines
  NICHT-blockierenden Toasts (unten rechts, via sonner) — ersetzt den früheren
  modalen „Was ist neu?"-Dialog. Der User kann nebenher weiterarbeiten (z.B. in
  einen Voice-Channel joinen), während der Toast steht, und ihn wegklicken.

  Voller Inhalt (Titel + alle Punkte + Intro/Outro), Plain-Text (repo-eigene
  Quelle, kein User-Input → kein Markdown/Sanitizer). KEINE Emojis.

  ``closeToast`` reicht sonner an die Custom-Component durch (Wegklicken). Custom-
  Component-Toasts rendert sonner unstyled → die Card-Optik liefern wir hier.
-->
<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import type { ChangelogEntry } from '$lib/changelog/types';

  let { entries = [], closeToast }: { entries?: ChangelogEntry[]; closeToast?: () => void } =
    $props();

  function fmtDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }
</script>

<div
  class="bg-bg-panel text-text-bright max-h-[70vh] w-full overflow-y-auto rounded-xl border border-border p-4 shadow-lg backdrop-blur-xl"
  data-testid="changelog-toast"
>
  <div class="flex items-start justify-between gap-3">
    <p class="text-sm font-semibold">Was ist neu?</p>
    <button
      type="button"
      onclick={() => closeToast?.()}
      class="text-text-muted hover:text-text-bright -m-1 shrink-0 rounded p-1"
      aria-label="Schließen"
      data-testid="changelog-toast-close"
    >
      <XIcon class="size-4" />
    </button>
  </div>

  <div class="mt-2 space-y-4">
    {#each entries as entry (entry.id)}
      <section data-testid="changelog-entry">
        <h3 class="text-sm font-semibold leading-tight">{entry.title}</h3>
        {#if entry.date}
          <p class="text-text-muted mt-0.5 text-xs">{fmtDate(entry.date)}</p>
        {/if}
        {#if entry.intro}
          <p class="text-text-muted mt-1.5 text-xs">{entry.intro}</p>
        {/if}
        <ul class="mt-2 space-y-1 text-xs">
          {#each entry.items as item}
            <li class="flex gap-1.5">
              <span aria-hidden="true" class="text-primary">›</span>
              <span>{item}</span>
            </li>
          {/each}
        </ul>
        {#if entry.outro}
          <p class="mt-2 text-xs font-medium">{entry.outro}</p>
        {/if}
      </section>
    {/each}
  </div>
</div>
