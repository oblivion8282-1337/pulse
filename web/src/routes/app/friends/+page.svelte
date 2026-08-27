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
  import { friends } from '$lib/stores/friends.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import FriendList from '$lib/components/friends/FriendList.svelte';
  import PendingRequests from '$lib/components/friends/PendingRequests.svelte';
  import BlockedList from '$lib/components/friends/BlockedList.svelte';
  import FriendsKopfAktionen from '$lib/components/friends/FriendsKopfAktionen.svelte';
  import AddFriendPanel from '$lib/components/friends/AddFriendPanel.svelte';
  import BereichsKopf from '$lib/components/mobile/BereichsKopf.svelte';
  import SearchIcon from '@lucide/svelte/icons/search';
  import XIcon from '@lucide/svelte/icons/x';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import BanIcon from '@lucide/svelte/icons/ban';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  // Suche über die Freundesliste — nur Namen, keine Nachrichten/Kanäle; das
  // Filtern (ab 3 Zeichen, sonderzeichen-frei) macht FriendList selbst.
  let freundeSuche = $state('');

  /** Anfragen-Zahl fürs Menü-Badge (Freundschafts- + Community-Einladungen). */
  const pendingBadge = $derived(friendRequests.incomingList.length + communityInvites.count);

  /** Titel der Unteransicht — steht neben dem Zurück-Pfeil. */
  function untertitel(): string {
    if (activeTab === 'pending') return m.friends_tab_pending();
    if (activeTab === 'blocked') return m.friends_tab_blocked();
    return m.friends_tab_add();
  }

  // 'online' ist 2026-08-27 entfallen: die Seite hat `onlineOnly` nie an
  // FriendList durchgereicht, der Reiter zeigte also dasselbe wie 'all'.
  // FriendList gruppiert ohnehin selbst in Online- und Offline-Block.
  type TabKey = 'all' | 'pending' | 'blocked' | 'add';
  const TABS: { key: TabKey; label: () => string }[] = [
    { key: 'all', label: () => m.friends_tab_all() },
    { key: 'add', label: () => m.friends_tab_add() },
    { key: 'pending', label: () => m.friends_tab_pending() },
    { key: 'blocked', label: () => m.friends_tab_blocked() }
  ];

  const activeTab = $derived<TabKey>(
    (TABS.find((t) => t.key === page.url.searchParams.get('tab'))?.key) ?? 'all'
  );

  // DEV-ONLY: ?demo=online markiert alle vorhandenen Freunde rotierend als
  // online/idle/dnd — für Layout-Tests der Freundesliste ohne echte Peers.
  // Läuft als Effect (statt einmalig beim Mount), damit auch nachträglich
  // geladene Freunde erfasst werden; ein echter Cloud-Seed gewinnt jederzeit.
  if (import.meta.env.DEV) {
    $effect(() => {
      if (page.url.searchParams.get('demo') !== 'online') return;
      const ids = friends.list.map((f) => f.user_id);
      presence.devSimulateFriendsOnline(ids);
    });
  }

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
    <BereichsKopf titel={m.friends_page_title()}>
      {#snippet handlung()}
        <!-- Drei-Punkte statt Reiter-Leiste (wie beim Chats-Bereich): die
             Liste gehört dem Inhalt, Seltenes (Hinzufügen, Anfragen, Blockiert)
             steckt im Menü. Die Anfragen-Zahl wandert als Badge mit. -->
        <FriendsKopfAktionen {activeTab} {pendingBadge} onSwitch={switchTab} />
        <div class="md:hidden">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-12 items-center justify-center rounded-[14px] transition-colors"
                data-testid="friends-menu"
                aria-label={m.chats_menu()}
              >
                <EllipsisIcon class="size-6" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-56">
            <DropdownMenu.Item
              onclick={() => switchTab('add')}
              data-testid="friends-menu-add"
              class="flex items-center gap-2"
            >
              <UserPlusIcon class="size-4" />
              {m.friends_tab_add()}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onclick={() => switchTab('pending')}
              data-testid="friends-menu-pending"
              class="flex items-center gap-2"
            >
              <ClockIcon class="size-4" />
              {m.friends_tab_pending()}
              {#if pendingBadge > 0}
                <span
                  class="bg-rose-500 text-white ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold leading-none"
                  data-testid="pending-badge"
                >
                  {pendingBadge}
                </span>
              {/if}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onclick={() => switchTab('blocked')}
              data-testid="friends-menu-blocked"
              class="flex items-center gap-2"
            >
              <BanIcon class="size-4" />
              {m.friends_tab_blocked()}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        </div>
      {/snippet}
    </BereichsKopf>
    <!-- Suchleiste außerhalb des Scroll-Bereichs, in derselben Hülle wie die
         der Chats (px-5 pb-5, gleiche Label-Klassen): gleiche Größe, gleiche
         Höhe — zwei Bereiche, dieselbe Frage „wo suche ich\" sollen sich
         nicht durch Versatz verraten. -->
    {#if activeTab !== 'pending' && activeTab !== 'blocked' && activeTab !== 'add'}
      <div class="px-5 pb-5" data-testid="friends-search-wrap">
        <label class="border-border bg-bg-input flex items-center gap-2 rounded-full border px-3 py-2">
          <SearchIcon class="text-text-muted size-4 shrink-0" />
          <input
            type="text"
            bind:value={freundeSuche}
            placeholder={m.friends_search_placeholder()}
            class="placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none"
            data-testid="friends-search-input"
            aria-label={m.friends_search_placeholder()}
          />
          {#if freundeSuche}
            <button
              type="button"
              onclick={() => (freundeSuche = '')}
              class="text-text-muted hover:text-text-bright shrink-0"
              data-testid="friends-search-clear"
              aria-label={m.chats_search_clear()}
            >
              <XIcon class="size-4" />
            </button>
          {/if}
        </label>
      </div>
    {/if}
    <div class="flex-1 overflow-y-auto px-4 pb-4">
      {#if activeTab === 'pending' || activeTab === 'blocked' || activeTab === 'add'}
        <!-- Unteransicht mit Zurück-Zeile statt Reiter: die Menü-Punkte sind
             Ausnahmefälle, kein parallel sichtbarer Zustand. -->
        <button
          type="button"
          class="text-text-muted hover:text-text-bright mb-3 flex items-center gap-1 pt-4 text-sm font-semibold md:hidden"
          onclick={() => switchTab('all')}
          data-testid="friends-back"
        >
          <ChevronLeftIcon class="size-5" />
          {untertitel()}
        </button>
        {#if activeTab === 'pending'}
          <PendingRequests />
        {:else if activeTab === 'blocked'}
          <BlockedList />
        {:else}
          <AddFriendPanel />
        {/if}
      {:else}
        <FriendList suche={freundeSuche} />
      {/if}
    </div>
  </section>
{/if}
