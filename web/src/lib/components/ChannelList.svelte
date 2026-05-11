<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
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
  let voiceChannels = $derived(channels.filter((c) => c.type === 1));

  function notImplemented(action: string, c: Channel) {
    toast.info(`„${action}“ für ${c.type === 1 ? '' : '#'}${c.name} ist noch nicht verfügbar.`, {
      description: 'Die entsprechende Backend-Route fehlt noch.'
    });
  }
</script>

<aside class="bg-bg-sidebar text-text-base flex h-full w-60 flex-col" data-testid="channel-list">
  <header class="flex h-12 items-center justify-between border-b border-black/30 px-4 font-semibold text-text-bright shadow-sm">
    <span class="truncate">{guild?.name ?? '—'}</span>
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
  </header>

  <nav class="flex-1 overflow-y-auto px-2 pb-3 pt-2">
    <div class="text-text-muted px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide">Text-Kanäle</div>
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
      <p class="text-text-muted px-2 py-2 text-xs">Noch keine Text-Kanäle.</p>
    {/if}

    <div class="text-text-muted px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide">Sprach-Kanäle</div>
    {#each voiceChannels as c (c.id)}
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
              <Volume2Icon class="text-text-muted size-4 shrink-0" />
              <span class="truncate">{c.name}</span>
              {#if voice.channelId === c.id && voice.connected}
                <span class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" title="verbunden"></span>
              {/if}
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
    {#if voiceChannels.length === 0}
      <p class="text-text-muted px-2 py-2 text-xs">Noch keine Sprach-Kanäle.</p>
    {/if}
  </nav>
</aside>
