<!--
  StreamLog — ausklappbares Log-Pane, gefüttert aus `session.lastLog`
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
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { streamForSlot } from '../state.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Show the log of one stream slot (0 = primary, 1 = the second stream).
  // `slot` is a reserved Svelte attribute name → prop is `streamSlot`.
  let { streamSlot: slot = 0 }: { streamSlot?: number } = $props();
  let session = $derived(streamForSlot(slot));

  let expanded = $state(false);
  let viewport = $state<HTMLDivElement | null>(null);
  let stickToBottom = $state(true);
  let copied = $state(false);
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyLog(event: MouseEvent) {
    // Toggle-Button drumherum nicht mit-aktivieren
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(session.lastLog.join('\n'));
      copied = true;
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copied = false;
        copyResetTimer = null;
      }, 1500);
    } catch {
      /* clipboard API kann in non-secure-Contexts failen — kein UI-Geräusch nötig */
    }
  }

  function onScroll() {
    if (!viewport) return;
    const distance = viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
    // ≈ within 24px of bottom counts as "at the bottom"
    stickToBottom = distance < 24;
  }

  // Wenn ein neuer Eintrag reinkommt: bei Bedarf ans Ende scrollen.
  // Wir leiten den Effekt aus `session.lastLog.length` ab, damit Svelte ihn
  // bei jeder Mutation triggert. Microtask weil das DOM erst nach dem
  // Re-Render aktualisiert ist.
  $effect(() => {
    void session.lastLog.length;
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
  <div class="flex items-center gap-1">
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
      <span class="text-text-muted ml-1 text-xs">({session.lastLog.length})</span>
    </Button>

    {#if expanded && session.lastLog.length > 0}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="gap-1.5"
        onclick={copyLog}
        data-testid="stream-log-copy"
        aria-label={m.stream_log_copy_aria_label()}
      >
        {#if copied}
          <CheckIcon class="size-3.5" />
          {m.stream_log_copied()}
        {:else}
          <CopyIcon class="size-3.5" />
          {m.stream_log_copy()}
        {/if}
      </Button>
    {/if}
  </div>

  {#if expanded}
    <div
      bind:this={viewport}
      onscroll={onScroll}
      class="bg-bg-input/60 text-text-base h-40 overflow-y-auto rounded-xl border border-border p-2 font-mono text-2xs leading-snug"
      data-testid="stream-log-viewport"
    >
      {#if session.lastLog.length === 0}
        <p class="text-text-muted italic">{m.stream_log_empty()}</p>
      {:else}
        {#each session.lastLog as line, i (i)}
          <div class="whitespace-pre-wrap break-all">{line}</div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
