<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
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

<!-- Horizontale Pill-/Avatar-Reihe der Server, oben in der Sidebar-Karte. -->
<div class="flex items-center gap-1.5 overflow-x-auto px-3 py-3" data-testid="guild-list">
  <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <a {...props} href="/app" class="shrink-0" aria-label="Pulse" data-testid="guild-home">
            <img src="/pulse-mark.svg" alt="" width="28" height="28" class="size-7 rounded-md" />
          </a>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Pulse</Tooltip.Content>
    </Tooltip.Root>
    <div class="bg-border h-6 w-px shrink-0" aria-hidden="true"></div>

    {#each guilds as g (g.id)}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-white transition-transform hover:scale-110 data-[active=true]:ring-2 data-[active=true]:ring-primary data-[active=true]:ring-offset-2 data-[active=true]:ring-offset-[color:var(--panel)]"
              style={g.icon_url?.startsWith('https://') ? '' : 'background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));'}
              data-active={activeGuildId === g.id}
              onclick={() => onSelect(g)}
              data-testid={`guild-${g.id}`}
            >
              {#if g.icon_url?.startsWith('https://')}
                <img src={g.icon_url} alt={g.name} class="size-full object-cover" />
              {:else}
                {initials(g.name)}
              {/if}
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="bottom">{g.name}</Tooltip.Content>
      </Tooltip.Root>
    {/each}

    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="border-primary/30 text-primary flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed bg-bg-input transition-colors hover:bg-bg-hover"
            onclick={onCreateClick}
            data-testid="guild-create"
            aria-label="Server erstellen"
          >
            <PlusIcon class="size-4" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Server erstellen</Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
</div>
