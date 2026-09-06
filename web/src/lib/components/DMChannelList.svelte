<script lang="ts">
  import AtSignIcon from '@lucide/svelte/icons/at-sign';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MailIcon from '@lucide/svelte/icons/mail';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { privateGruppen } from '$lib/stores/privateGruppen.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { readState } from '$lib/stores/readState.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import { communityInvites } from '$lib/stores/communityInvites.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import SidebarFooter from './SidebarFooter.svelte';
  import type { DMChannel } from '$lib/api/types';

  let {
    activeDMId = null,
    onSelect,
    onSelectGruppe
  }: {
    activeDMId?: string | null;
    onSelect: (dm: DMChannel) => void;
    /** Eine private Gruppe oeffnen (Etappe G). Fehlt der Rueckruf, bleibt der
     *  Abschnitt aus — die Liste behauptet dann nicht, es gaebe Gruppen. */
    onSelectGruppe?: (gruppeId: string) => void;
  } = $props();

  const friendsActive = $derived(page.url.pathname.startsWith('/app/friends'));
  const pendingCount = $derived(friendRequests.incomingList.length);
  const invitesActive = $derived(page.url.pathname.startsWith('/app/invites'));
  // Getrennt vom Freunde-Zaehler: der Sinn des eigenen Eintrags ist, dass die
  // Zahl vor dem Klick sagt, WORUM es geht. Eine Summe aus beidem tut das nicht.
  const invitesCount = $derived(communityInvites.count);

  // Make sure the other-user's profile (name + avatar) is in the user cache.
  // The store debounces a batch fetch, so spamming queue() is cheap.
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });

  function displayName(dm: DMChannel): string {
    return userCache.displayName(dm.other_user_id);
  }

  // Die zwei Zwillings-Knöpfe (Freunde/Einladungen) als Konfiguration —
  // `mutedLabel` nur beim Einladungs-Knopf: sein Label graut aus, wenn
  // nichts pending ist; beim Freunde-Knopf ist der Badge der einzige Hinweis.
  const navButtons = $derived([
    {
      icon: UsersIcon,
      href: '/app/friends',
      label: m.nav_freunde(),
      count: pendingCount,
      active: friendsActive,
      testid: 'sidebar-friends',
      mutedLabel: false
    },
    {
      icon: MailIcon,
      href: '/app/invites',
      label: m.nav_einladungen(),
      count: invitesCount,
      active: invitesActive,
      testid: 'sidebar-invites',
      mutedLabel: true
    }
  ]);
</script>

<aside
  class="glass-panel text-text-base flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:w-60 md:flex-none md:rounded-2xl lg:w-68"
  data-testid="dm-channel-list"
>
  <header class="text-text-bright flex h-12 items-center px-4 pt-3">
    <span class="truncate text-base font-bold tracking-tight">@me</span>
  </header>

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3 pt-2">
    <!-- Kein Gruppentitel ueber diesen beiden: er hiess "Freunde" und stand
         damit direkt ueber dem gleichnamigen Knopf. Die zwei Eintraege
         beschriften sich selbst; die Trennlinie darunter grenzt sie von den
         Direktnachrichten ab. -->
    {#each navButtons as btn (btn.href)}
      <button
        class="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-base font-medium transition-colors md:gap-2.5 md:py-2 md:text-sm hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
        data-active={btn.active}
        onclick={() => goto(btn.href)}
        data-testid="{btn.testid}-link"
      >
        <btn.icon
          class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary"
        />
        <span class="truncate {btn.mutedLabel && btn.count === 0 ? 'text-text-muted' : ''}">{btn.label}</span>
        {#if btn.count > 0}
          <span
            class="bg-rose-500 text-white ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold leading-none"
            data-testid="{btn.testid}-badge"
          >
            {btn.count}
          </span>
        {/if}
      </button>
    {/each}

    <div class="my-3 hairline bg-border" aria-hidden="true"></div>
    <p
      class="text-text-muted px-3 pb-1 text-2xs font-semibold uppercase tracking-wider"
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
            class="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-badge-count px-1 text-2xs font-bold leading-none text-white"
            data-testid="dm-unread-pill"
            data-unread-count={unreadCount}
            aria-label="ungelesen"
          >{unreadCount > 99 ? '99+' : unreadCount}</span>
        {:else if isUnread}
          <span
            class="ml-auto size-2 shrink-0 rounded-full bg-badge-count"
            data-testid="dm-unread-dot"
            aria-label="ungelesen"
          ></span>
        {/if}
      </button>
    {/each}

    <!-- Private Gruppen (Etappe G). Eigener Abschnitt statt untergemischt:
         `listed`/DM und Gruppe sind zwei Begriffe, und wer sie in EINE Liste
         legt, muss sie an jeder Stelle danach wieder auseinandersortieren.
         Der Abschnitt fehlt ganz, solange es keine Gruppe gibt — ein leerer
         Titel waere eine Ankuendigung ohne Inhalt. -->
    {#if onSelectGruppe && privateGruppen.list.length > 0}
      <div class="my-3 hairline bg-border" aria-hidden="true"></div>
      <p class="text-text-muted px-3 pb-1 text-2xs font-semibold uppercase tracking-wider">
        {m.dm_list_gruppen_heading()}
      </p>
      {#each privateGruppen.list as gruppe (gruppe.id)}
        {@const isUnread = activeDMId !== gruppe.id && readState.isUnread(gruppe.id)}
        {@const unreadCount = activeDMId !== gruppe.id ? readState.getUnreadCount(gruppe.id) : 0}
        <button
          class="group flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left text-base font-medium transition-colors md:gap-2.5 md:py-2 md:text-sm hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
          data-active={activeDMId === gruppe.id}
          data-unread={isUnread}
          onclick={() => onSelectGruppe(gruppe.id)}
          data-testid={`gruppe-${gruppe.id}`}
        >
          <UsersIcon
            class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright"
          />
          <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}">
            {gruppe.name}
          </span>
          {#if unreadCount > 0}
            <span
              class="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-badge-count px-1 text-2xs font-bold leading-none text-white"
              data-testid="gruppe-unread-pill"
              data-unread-count={unreadCount}
              aria-label="ungelesen"
            >{unreadCount > 99 ? '99+' : unreadCount}</span>
          {:else if isUnread}
            <span
              class="ml-auto size-2 shrink-0 rounded-full bg-badge-count"
              data-testid="gruppe-unread-dot"
              aria-label="ungelesen"
            ></span>
          {/if}
        </button>
      {/each}
    {/if}
  </nav>

  <SidebarFooter />
</aside>
