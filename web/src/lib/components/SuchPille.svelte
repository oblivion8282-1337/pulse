<!--
  SuchPille — die runde Suchleiste, die Chats-, Freunde- und Räume-Bereich
  teilen (gleiche Hülle, gleiche Größe, dieselbe Frage „wo suche ich").
  Bindet den Suchbegriff per `bind:value`; der Clear-Knopf erscheint nur bei
  Inhalt. Die `*-search-clear`-Testid-Nomenklatur bleibt erhalten.
-->
<script lang="ts">
  import SearchIcon from '@lucide/svelte/icons/search';
  import XIcon from '@lucide/svelte/icons/x';
  import { m } from '$lib/paraglide/messages.js';

  let {
    value = $bindable(''),
    placeholder,
    testid
  }: {
    value?: string;
    placeholder: string;
    /** Präfix der Test-IDs: `<testid>-wrap`, `-input`, `-clear`. */
    testid: string;
  } = $props();
</script>

<div class="px-5 pb-5" data-testid="{testid}-wrap">
  <label class="border-border bg-bg-input flex items-center gap-2 rounded-full border px-3 py-2">
    <SearchIcon class="text-text-muted size-4 shrink-0" />
    <input
      type="text"
      bind:value
      {placeholder}
      class="placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none"
      data-testid="{testid}-input"
      aria-label={placeholder}
    />
    {#if value}
      <button
        type="button"
        onclick={() => (value = '')}
        class="text-text-muted hover:text-text-bright shrink-0"
        data-testid="{testid}-clear"
        aria-label={m.chats_search_clear()}
      >
        <XIcon class="size-4" />
      </button>
    {/if}
  </label>
</div>
