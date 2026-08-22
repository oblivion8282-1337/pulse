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
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import { communityInvites } from '$lib/stores/communityInvites.svelte';
  import FriendList from '$lib/components/friends/FriendList.svelte';
  import PendingRequests from '$lib/components/friends/PendingRequests.svelte';
  import BlockedList from '$lib/components/friends/BlockedList.svelte';
  import AddFriendPanel from '$lib/components/friends/AddFriendPanel.svelte';
  import BereichsKopf from '$lib/components/mobile/BereichsKopf.svelte';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  type TabKey = 'online' | 'all' | 'pending' | 'blocked' | 'add';
  const TABS: { key: TabKey; label: () => string }[] = [
    { key: 'online', label: () => m.friends_tab_online() },
    { key: 'all', label: () => m.friends_tab_all() },
    { key: 'add', label: () => m.friends_tab_add() },
    { key: 'pending', label: () => m.friends_tab_pending() },
    { key: 'blocked', label: () => m.friends_tab_blocked() }
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
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
  onHomeClick={async () => {
    navDrawer.open = !navDrawer.open;
    await goto('/app/friends');
  }}
/>

<!-- Die DM-Spalte gehoert ab `md` neben die Freunde; auf dem Handy sind
     private Gespraeche ein eigener Bereich (Chats), eine zweite Liste hier
     waere derselbe Inhalt an zwei Orten. -->
{#if !viewport.isMobile}
  <DMChannelList activeDMId={null} onSelect={selectDM} />
{/if}

{#if true}
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
    data-testid="friends-page"
  >
    <BereichsKopf titel={m.friends_page_title()} />
    <div class="border-border/40 shrink-0 border-b px-4 pb-3">
      <!-- Auf dem Handy scrollt die Reiter-Reihe waagerecht, statt in zwei
           Zeilen umzubrechen: fuenf Reiter passen auf 390 px nicht nebeneinander,
           und eine zweite Zeile schoebe die Liste bei jedem Wechsel hoch und
           runter. -->
      <nav
        class="-mx-1 flex gap-1.5 overflow-x-auto px-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
        data-testid="friends-tabs"
      >
        {#each TABS as t (t.key)}
          {@const isActive = activeTab === t.key}
          {@const badge =
            t.key === 'pending'
              ? friendRequests.incomingList.length + communityInvites.count
              : 0}
          <button
            type="button"
            class="hover:bg-bg-hover relative flex min-h-12 shrink-0 items-center rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors md:min-h-0 md:rounded-md md:py-1 md:text-sm md:font-medium {isActive
              ? 'bg-[var(--accent-soft)] text-accent-on-soft'
              : 'text-text-muted hover:text-text-bright'}"
            onclick={() => switchTab(t.key)}
            data-testid={`friends-tab-${t.key}`}
            data-active={isActive}
          >
            {t.label()}
            {#if badge > 0}
              <span
                class="bg-rose-500 text-white ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold leading-none"
                data-testid="pending-badge"
              >
                {badge}
              </span>
            {/if}
          </button>
        {/each}
      </nav>
    </div>
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
