<!--
  StreamLog — ausklappbares Log-Pane, gefüttert aus `stream.lastLog`
  (GSR-stderr-Tail, gepushed via `gsr://event` "log"-Events).

  Auto-scroll-to-bottom wenn der User nicht hochgescrollt hat — Pattern:
  Wir merken uns mit `stickToBottom` ob das Viewport "nahe am Ende" ist.
  Wenn ja, fahren wir bei jedem neuen `lastLog`-Eintrag runter; wenn der
  User aktiv hochgescrollt hat, lassen wir das Viewport in Ruhe.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import { stream } from '../state.svelte';

  let expanded = $state(false);
  let viewport = $state<HTMLDivElement | null>(null);
  let stickToBottom = $state(true);

  function onScroll() {
    if (!viewport) return;
    const distance = viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
    // ≈ within 24px of bottom counts as "at the bottom"
    stickToBottom = distance < 24;
  }

  // Wenn ein neuer Eintrag reinkommt: bei Bedarf ans Ende scrollen.
  // Wir leiten den Effekt aus `stream.lastLog.length` ab, damit Svelte ihn
  // bei jeder Mutation triggert. Microtask weil das DOM erst nach dem
  // Re-Render aktualisiert ist.
  $effect(() => {
    void stream.lastLog.length;
    if (expanded && stickToBottom && viewport) {
      queueMicrotask(() => {
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      });
    }
  });

  // Wenn der User das Pane öffnet: einmal an den Boden, stickToBottom an.
  $effect(() => {
    if (expanded && viewport) {
      queueMicrotask(() => {
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      });
      stickToBottom = true;
    }
  });
</script>

<div class="flex flex-col gap-1.5" data-testid="stream-log">
  <Button
    type="button"
    variant="ghost"
    size="sm"
    class="w-fit gap-1.5"
    onclick={() => (expanded = !expanded)}
    data-testid="stream-log-toggle"
    aria-expanded={expanded}
  >
    {#if expanded}<ChevronDownIcon class="size-3.5" />
    {:else}<ChevronRightIcon class="size-3.5" />{/if}
    Log
    <span class="text-text-muted ml-1 text-xs">({stream.lastLog.length})</span>
  </Button>

  {#if expanded}
    <div
      bind:this={viewport}
      onscroll={onScroll}
      class="bg-bg-input/60 text-text-base h-40 overflow-y-auto rounded-lg border border-border p-2 font-mono text-[11px] leading-snug"
      data-testid="stream-log-viewport"
    >
      {#if stream.lastLog.length === 0}
        <p class="text-text-muted italic">(noch nichts geloggt)</p>
      {:else}
        {#each stream.lastLog as line, i (i)}
          <div class="whitespace-pre-wrap break-all">{line}</div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
