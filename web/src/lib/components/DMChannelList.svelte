<script lang="ts">
  import AtSignIcon from '@lucide/svelte/icons/at-sign';
  import UsersIcon from '@lucide/svelte/icons/users';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { readState } from '$lib/stores/readState.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
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

  const friendsActive = $derived(page.url.pathname.startsWith('/app/friends'));
  const pendingCount = $derived(friendRequests.incomingList.length);

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
    <span class="truncate text-base font-bold tracking-tight">@me</span>
  </header>

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
    <p
      class="text-text-muted px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider"
    >
      Freunde
    </p>
    <button
      class="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-base font-medium transition-colors md:gap-2.5 md:py-2 md:text-sm hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
      data-active={friendsActive}
      onclick={() => goto('/app/friends')}
      data-testid="sidebar-friends-link"
    >
      <UsersIcon
        class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary"
      />
      <span class="truncate">Freunde</span>
      {#if pendingCount > 0}
        <span
          class="bg-rose-500 text-white ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
          data-testid="sidebar-friends-badge"
        >
          {pendingCount}
        </span>
      {/if}
    </button>
    <p
      class="text-text-muted px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider"
    >
      Direktnachrichten
    </p>
    {#if directMessages.list.length === 0}
      <p class="text-text-muted px-3 py-2 text-xs">
        Noch keine DMs. Klick auf einen User im Channel, um eine zu starten.
      </p>
    {/if}
    {#each directMessages.list as dm (dm.id)}
      {@const isUnread = activeDMId !== dm.id && readState.isUnread(dm.id)}
      {@const unreadCount = activeDMId !== dm.id ? readState.getUnreadCount(dm.id) : 0}
      {@const u = userCache.get(dm.other_user_id)}
      {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
      <button
        class="group flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left text-base font-medium transition-colors md:gap-2.5 md:py-2 md:text-sm hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
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
            class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright"
          />
        {/if}
        <span
          class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}"
          style={nameStyle(dm.other_user_id)}
        >
          {displayName(dm)}
        </span>
        {#if unreadCount > 0}
          <span
            class="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
            data-testid="dm-unread-pill"
            data-unread-count={unreadCount}
            aria-label="ungelesen"
          >{unreadCount > 99 ? '99+' : unreadCount}</span>
        {:else if isUnread}
          <span
            class="ml-auto size-2 shrink-0 rounded-full bg-red-500"
            data-testid="dm-unread-dot"
            aria-label="ungelesen"
          ></span>
        {/if}
      </button>
    {/each}
  </nav>

  <SidebarFooter />
</aside>
