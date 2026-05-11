<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
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
  class="bg-bg-base flex h-full w-[72px] flex-col items-center gap-2 py-3"
  data-testid="guild-list"
>
  <Tooltip.Provider delayDuration={200}>
    {#each guilds as g (g.id)}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="group bg-bg-channels text-text-bright hover:bg-primary relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-3xl text-sm font-semibold transition-all hover:rounded-xl data-[active=true]:rounded-xl"
              data-active={activeGuildId === g.id}
              onclick={() => onSelect(g)}
              data-testid={`guild-${g.id}`}
            >
              {#if g.icon_url?.startsWith('https://')}
                <img src={g.icon_url} alt={g.name} class="h-full w-full object-cover" />
              {:else}
                {initials(g.name)}
              {/if}
              <span
                class="absolute -left-1 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r bg-white opacity-0 transition-all group-hover:h-5 group-hover:opacity-100"
                class:always-visible={activeGuildId === g.id}
              ></span>
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="right">{g.name}</Tooltip.Content>
      </Tooltip.Root>
    {/each}

    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="bg-bg-channels flex h-12 w-12 items-center justify-center rounded-3xl text-green-400 transition-all hover:rounded-xl hover:bg-green-600 hover:text-white"
            onclick={onCreateClick}
            data-testid="guild-create"
          >
            <PlusIcon class="size-6" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="right">Server erstellen</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
</aside>

<style>
  .always-visible {
    height: 1.5rem;
    opacity: 1;
  }
</style>
