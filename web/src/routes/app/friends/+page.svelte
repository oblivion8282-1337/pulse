<!--
  /app/friends — tabbed view over friends, pending requests, blocked
  users and "add friend". Tab is mirrored to the ?tab=… search param
  so deep-links and back/forward navigation hold. Default tab: online.

  Renders inside the existing app shell (GuildRail + DMChannelList).
  The DM list stays mounted so the user can still hop between DMs from
  here — same UX as Discord's "Friends" page.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import FriendList from '$lib/components/friends/FriendList.svelte';
  import PendingRequests from '$lib/components/friends/PendingRequests.svelte';
  import BlockedList from '$lib/components/friends/BlockedList.svelte';
  import AddFriendPanel from '$lib/components/friends/AddFriendPanel.svelte';
  import type { DMChannel } from '$lib/api/types';

  type TabKey = 'online' | 'all' | 'pending' | 'blocked' | 'add';
  const TABS: { key: TabKey; label: string }[] = [
    { key: 'online', label: 'Online' },
    { key: 'all', label: 'Alle' },
    { key: 'pending', label: 'Ausstehend' },
    { key: 'blocked', label: 'Blockiert' },
    { key: 'add', label: 'Hinzufügen' }
  ];

  const activeTab = $derived<TabKey>(
    (TABS.find((t) => t.key === page.url.searchParams.get('tab'))?.key) ?? 'online'
  );

  async function switchTab(key: TabKey) {
    const url = new URL(page.url);
    url.searchParams.set('tab', key);
    await goto(url.pathname + url.search, { replaceState: true, keepFocus: true });
  }

  async function selectGuild(g: { id: string }) {
    navDrawer.open = true;
    await goto(`/app/guilds/${g.id}/channels/_`);
  }

  async function selectDM(dm: DMChannel) {
    navDrawer.open = false;
    await goto(`/app/@me/${dm.id}`);
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={auth.user?.id ?? null}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={
    auth.user?.is_admin || capabilities.allowGuildCreation ? () => goto('/app') : undefined
  }
  onHomeClick={async () => {
    navDrawer.open = !navDrawer.open;
    await goto('/app/@me');
  }}
/>

{#if !viewport.isMobile || navDrawer.open}
  <DMChannelList activeDMId={null} onSelect={selectDM} />
{/if}

{#if !viewport.isMobile || !navDrawer.open}
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
    data-testid="friends-page"
  >
    <header class="border-border/40 flex items-center gap-4 border-b px-4 py-3">
      <h1 class="text-text-bright text-base font-semibold">Freunde</h1>
      <nav class="flex flex-wrap gap-1" data-testid="friends-tabs">
        {#each TABS as t (t.key)}
          {@const isActive = activeTab === t.key}
          {@const badge = t.key === 'pending' ? friendRequests.incomingList.length : 0}
          <button
            type="button"
            class="hover:bg-bg-hover relative rounded-md px-3 py-1 text-sm font-medium transition-colors {isActive
              ? 'bg-[var(--accent-soft)] text-primary'
              : 'text-text-muted hover:text-text-bright'}"
            onclick={() => switchTab(t.key)}
            data-testid={`friends-tab-${t.key}`}
            data-active={isActive}
          >
            {t.label}
            {#if badge > 0}
              <span
                class="bg-rose-500 text-white ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
                data-testid="pending-badge"
              >
                {badge}
              </span>
            {/if}
          </button>
        {/each}
      </nav>
    </header>
    <div class="flex-1 overflow-y-auto px-4 py-4">
      {#if activeTab === 'online'}
        <FriendList onlineOnly />
      {:else if activeTab === 'all'}
        <FriendList />
      {:else if activeTab === 'pending'}
        <PendingRequests />
      {:else if activeTab === 'blocked'}
        <BlockedList />
      {:else if activeTab === 'add'}
        <AddFriendPanel />
      {/if}
    </div>
  </section>
{/if}
