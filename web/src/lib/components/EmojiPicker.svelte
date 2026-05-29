<script lang="ts">
  import { EMOJIS, CATEGORY_ORDER, CATEGORY_LABELS, type EmojiCategory } from '$lib/emoji';

  const CATEGORY_REPRESENTATIVE = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, EMOJIS.find((e) => e.category === c)?.emoji ?? '·'])
  );

  let { onPick }: { onPick: (emoji: string) => void } = $props();

  let query = $state('');
  let active = $state<EmojiCategory>('smileys');

  const grouped = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const byCat: Record<EmojiCategory, typeof EMOJIS> = {
      smileys: [], gestures: [], hearts: [], nature: [], food: [], travel: [], objects: [], flags: []
    };
    for (const e of EMOJIS) {
      if (q && !e.name.includes(q) && !(e.aliases ?? []).some((a) => a.includes(q))) continue;
      byCat[e.category].push(e);
    }
    return byCat;
  });

  const isSearching = $derived(query.trim().length > 0);
  const searchHits = $derived(isSearching ? CATEGORY_ORDER.flatMap((c) => grouped[c]) : []);
</script>

<div
  class="bg-popover text-popover-foreground flex w-72 flex-col gap-2 rounded-2xl border border-border p-3 shadow-xl backdrop-blur-xl"
  data-testid="emoji-picker"
  role="dialog"
  aria-label="Emoji wählen"
>
  <input
    type="text"
    bind:value={query}
    placeholder="Suchen…"
    class="text-text-bright placeholder:text-text-muted w-full rounded-lg border border-border bg-bg-chat px-2.5 py-1.5 text-sm outline-none focus:border-primary"
    aria-label="Emoji suchen"
    data-testid="emoji-picker-search"
  />

  {#if !isSearching}
    <div class="flex gap-1 border-b border-border pb-1.5">
      {#each CATEGORY_ORDER as cat (cat)}
        <button
          type="button"
          class="rounded-md px-2 py-1 text-base hover:bg-bg-hover {active === cat ? 'bg-bg-hover ring-1 ring-primary' : ''}"
          onclick={() => (active = cat)}
          title={CATEGORY_LABELS[cat]}
          aria-pressed={active === cat}
        >
          {CATEGORY_REPRESENTATIVE[cat]}
        </button>
      {/each}
    </div>
  {/if}

  <div class="max-h-72 overflow-y-auto">
    {#if isSearching}
      {#if searchHits.length === 0}
        <p class="text-text-muted px-1 py-3 text-center text-xs">Keine Treffer</p>
      {:else}
        <div class="grid grid-cols-6 gap-1 md:grid-cols-8">
          {#each searchHits as e (e.emoji)}
            <button
              type="button"
              class="rounded-md p-2 text-2xl hover:bg-bg-hover md:p-1 md:text-xl"
              title=":{e.name}:"
              onclick={() => onPick(e.emoji)}
            >{e.emoji}</button>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="grid grid-cols-8 gap-1">
        {#each grouped[active] as e (e.emoji)}
          <button
            type="button"
            class="rounded-md p-1 text-xl hover:bg-bg-hover"
            title=":{e.name}:"
            onclick={() => onPick(e.emoji)}
          >{e.emoji}</button>
        {/each}
      </div>
    {/if}
  </div>
</div>
