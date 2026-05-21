<script lang="ts">
  import AtSignIcon from '@lucide/svelte/icons/at-sign';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import SidebarFooter from './SidebarFooter.svelte';
  import type { DMChannel } from '$lib/api/types';

  let {
    activeDMId = null,
    onSelect
  }: {
    activeDMId?: string | null;
    onSelect: (dm: DMChannel) => void;
  } = $props();

  // Make sure the other-user's profile (name + avatar) is in the user cache.
  // The store debounces a batch fetch, so spamming queue() is cheap.
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });

  function displayName(dm: DMChannel): string {
    return userCache.displayName(dm.other_user_id);
  }
</script>

<aside
  class="glass-panel text-text-base flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:w-60 md:flex-none md:rounded-2xl lg:w-68"
  data-testid="dm-channel-list"
>
  <header class="text-text-bright flex h-12 items-center px-4 pt-3">
    <span class="truncate text-base font-bold tracking-tight">Direktnachrichten</span>
  </header>

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
    {#if directMessages.list.length === 0}
      <p class="text-text-muted px-3 py-2 text-xs">
        Noch keine DMs. Klick auf einen User im Channel, um eine zu starten.
      </p>
    {/if}
    {#each directMessages.list as dm (dm.id)}
      {@const isUnread = activeDMId !== dm.id && readState.isUnread(dm.id)}
      {@const u = userCache.get(dm.other_user_id)}
      {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
      <button
        class="group flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-sm font-medium transition-colors md:py-2 hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
        data-active={activeDMId === dm.id}
        data-unread={isUnread}
        onclick={() => onSelect(dm)}
        data-testid={`dm-${dm.id}`}
      >
        {#if avatar}
          <img
            src={avatar}
            alt=""
            class="size-6 shrink-0 rounded-full object-cover"
          />
        {:else}
          <AtSignIcon
            class="text-text-muted size-[17px] shrink-0 group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright"
          />
        {/if}
        <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}">
          {displayName(dm)}
        </span>
        {#if isUnread}
          <span
            class="ml-auto size-2 shrink-0 rounded-full bg-primary"
            data-testid="dm-unread-dot"
            aria-label="ungelesen"
          ></span>
        {/if}
      </button>
    {/each}
  </nav>

  <SidebarFooter />
</aside>
