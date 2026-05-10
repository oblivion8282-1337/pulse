<script lang="ts">
  import type { Guild } from '$lib/api/types';

  let {
    guilds,
    activeGuildId = null,
    onSelect,
    onCreateClick
  }: {
    guilds: Guild[];
    activeGuildId?: string | null;
    onSelect: (g: Guild) => void;
    onCreateClick: () => void;
  } = $props();

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .slice(0, 2)
      .join('');
  }
</script>

<aside
  class="flex h-full w-[72px] flex-col items-center gap-2 bg-[var(--color-bg-base)] py-3"
  data-testid="guild-list"
>
  {#each guilds as g (g.id)}
    <button
      class="group relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-3xl bg-[var(--color-bg-channels)] text-sm font-semibold text-[var(--color-text-bright)] transition-all hover:rounded-xl hover:bg-[var(--color-accent)]"
      class:active={activeGuildId === g.id}
      onclick={() => onSelect(g)}
      title={g.name}
      data-testid={`guild-${g.id}`}
    >
      {#if g.icon_url}
        <img src={g.icon_url} alt={g.name} class="h-full w-full object-cover" />
      {:else}
        {initials(g.name)}
      {/if}
      <span
        class="absolute -left-1 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r bg-white opacity-0 transition-all group-hover:h-5 group-hover:opacity-100"
        class:always-visible={activeGuildId === g.id}
      ></span>
    </button>
  {/each}

  <button
    class="flex h-12 w-12 items-center justify-center rounded-3xl bg-[var(--color-bg-channels)] text-2xl text-green-400 transition-all hover:rounded-xl hover:bg-green-500 hover:text-white"
    onclick={onCreateClick}
    title="Server erstellen"
    data-testid="guild-create"
  >
    +
  </button>
</aside>

<style>
  .active {
    border-radius: 0.75rem;
    background: var(--color-accent);
  }
  .always-visible {
    height: 1.5rem;
    opacity: 1;
  }
</style>
