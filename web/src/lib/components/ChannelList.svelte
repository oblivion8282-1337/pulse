<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { toast } from 'svelte-sonner';
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

  let textChannels = $derived(channels.filter((c) => c.type === 0));

  function notImplemented(action: string, c: Channel) {
    toast.info(`„${action}“ für #${c.name} ist noch nicht verfügbar.`, {
      description: 'Die entsprechende Backend-Route fehlt noch.'
    });
  }
</script>

<aside
  class="bg-bg-sidebar text-text-base flex h-full w-60 flex-col"
  data-testid="channel-list"
>
  <header class="flex h-12 items-center border-b border-black/30 px-4 font-semibold text-text-bright shadow-sm">
    {guild?.name ?? '—'}
  </header>

  <div class="text-text-muted flex items-center justify-between px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide">
    <span>Text-Kanäle</span>
    {#if canCreate}
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-text-muted hover:text-white"
        onclick={onCreateClick}
        data-testid="channel-create"
        aria-label="Kanal erstellen"
      >
        <PlusIcon />
      </Button>
    {/if}
  </div>

  <nav class="flex-1 overflow-y-auto px-2 pb-3">
    {#each textChannels as c (c.id)}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="hover:bg-bg-hover flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors data-[active=true]:bg-bg-hover data-[active=true]:text-text-bright"
              data-active={activeChannelId === c.id}
              onclick={() => onSelect(c)}
              data-testid={`channel-${c.id}`}
            >
              <HashIcon class="text-text-muted size-4 shrink-0" />
              <span class="truncate">{c.name}</span>
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => notImplemented('Kanal umbenennen', c)}>
            <PencilIcon />
            Kanal umbenennen
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item variant="destructive" onSelect={() => notImplemented('Kanal löschen', c)}>
            <Trash2Icon />
            Kanal löschen
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    {/each}
    {#if textChannels.length === 0}
      <p class="text-text-muted px-2 py-3 text-xs">Noch keine Kanäle.</p>
    {/if}
  </nav>
</aside>
