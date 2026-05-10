<script lang="ts">
  import type { Channel, Guild } from '$lib/api/types';

  let {
    guild,
    channels,
    activeChannelId = null,
    onSelect,
    onCreateClick,
    canCreate = false
  }: {
    guild: Guild | null;
    channels: Channel[];
    activeChannelId?: string | null;
    onSelect: (c: Channel) => void;
    onCreateClick: () => void;
    canCreate?: boolean;
  } = $props();
</script>

<aside
  class="flex h-full w-60 flex-col bg-[var(--color-bg-sidebar)] text-[var(--color-text-base)]"
  data-testid="channel-list"
>
  <header class="flex h-12 items-center border-b border-black/30 px-4 font-semibold text-[var(--color-text-bright)] shadow-sm">
    {guild?.name ?? '—'}
  </header>

  <div class="flex items-center justify-between px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
    <span>Text-Kanäle</span>
    {#if canCreate}
      <button
        class="text-base text-[var(--color-text-muted)] transition-colors hover:text-white"
        onclick={onCreateClick}
        title="Kanal erstellen"
        data-testid="channel-create"
      >+</button>
    {/if}
  </div>

  <nav class="flex-1 overflow-y-auto px-2 pb-3">
    {#each channels.filter((c) => c.type === 0) as c (c.id)}
      <button
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--color-bg-hover)]"
        class:active={activeChannelId === c.id}
        onclick={() => onSelect(c)}
        data-testid={`channel-${c.id}`}
      >
        <span class="text-[var(--color-text-muted)]">#</span>
        <span class="truncate">{c.name}</span>
      </button>
    {/each}
    {#if channels.filter((c) => c.type === 0).length === 0}
      <p class="px-2 py-3 text-xs text-[var(--color-text-muted)]">
        Noch keine Kanäle.
      </p>
    {/if}
  </nav>
</aside>

<style>
  .active {
    background: var(--color-bg-hover);
    color: var(--color-text-bright);
  }
</style>
