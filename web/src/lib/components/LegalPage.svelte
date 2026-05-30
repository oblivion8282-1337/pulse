<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import { renderLegal } from '$lib/legal/renderLegal';

  interface Props {
    /** Roh-Markdown (per `?raw`-Import der jeweiligen Datei). */
    source: string;
  }

  let { source }: Props = $props();

  // Quelle ist statisch (per ?raw-Import), $derived hält es trotzdem sauber
  // reaktiv — kein state_referenced_locally-Lint.
  const html = $derived(renderLegal(source));
</script>

<div class="bg-background text-foreground min-h-dvh">
  <div class="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
    <header class="mb-8 flex items-center justify-between gap-4">
      <a href="/login" class="flex items-center gap-2.5">
        <img src="/pulse-mark.svg" alt="Pulse" width="32" height="32" class="size-8" />
        <span class="text-lg font-semibold">Pulse</span>
      </a>
      <a href="/login" class="text-muted-foreground hover:text-foreground text-sm hover:underline">
        {m.legal_page_back()}
      </a>
    </header>

    <article class="legal-prose">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html html}
    </article>
  </div>
</div>

<style>
  /* Prose-Styling für das gerenderte Markdown. :global, weil das HTML per
     {@html} injiziert wird und Sveltes Scoping es sonst nicht trifft. Farben
     über die Theme-CSS-Variablen, damit Light/Dark automatisch passen. */
  .legal-prose :global(h1) {
    font-size: 1.875rem;
    line-height: 2.25rem;
    font-weight: 800;
    letter-spacing: -0.01em;
    margin-bottom: 1.5rem;
  }
  .legal-prose :global(h2) {
    font-size: 1.25rem;
    line-height: 1.75rem;
    font-weight: 600;
    margin-top: 2.25rem;
    margin-bottom: 0.75rem;
    padding-bottom: 0.375rem;
    border-bottom: 1px solid var(--border);
  }
  .legal-prose :global(h3) {
    font-size: 1.05rem;
    font-weight: 600;
    margin-top: 1.5rem;
    margin-bottom: 0.5rem;
  }
  .legal-prose :global(p) {
    margin: 0.75rem 0;
    line-height: 1.7;
  }
  .legal-prose :global(ul),
  .legal-prose :global(ol) {
    margin: 0.75rem 0;
    padding-left: 1.5rem;
  }
  .legal-prose :global(ul) {
    list-style: disc;
  }
  .legal-prose :global(ol) {
    list-style: decimal;
  }
  .legal-prose :global(li) {
    margin: 0.3rem 0;
    line-height: 1.6;
  }
  .legal-prose :global(a) {
    color: var(--primary);
    text-decoration: underline;
  }
  .legal-prose :global(strong) {
    font-weight: 600;
  }
  .legal-prose :global(blockquote) {
    border-left: 3px solid var(--border);
    padding: 0.25rem 0 0.25rem 1rem;
    margin: 1rem 0;
    color: var(--muted-foreground);
  }
  .legal-prose :global(code) {
    background: var(--muted);
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
    font-size: 0.875em;
  }
  .legal-prose :global(hr) {
    margin: 2rem 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .legal-prose :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    font-size: 0.9rem;
  }
  .legal-prose :global(th),
  .legal-prose :global(td) {
    border: 1px solid var(--border);
    padding: 0.5rem 0.75rem;
    text-align: left;
    vertical-align: top;
  }
  .legal-prose :global(th) {
    background: var(--muted);
    font-weight: 600;
  }
</style>
