<script lang="ts">
  /**
   * Der Chats-Bereich des Handys: die privaten Gespräche als Messenger-Liste.
   *
   * **Eine eigene Komponente neben `DMChannelList.svelte`, nicht eine
   * gemeinsame mit zwei Dichten.** Die beiden sind nicht dasselbe in
   * unterschiedlicher Grösse: die Seitenleiste des Rechners ist eine schmale
   * Navigation neben dem Chat und führt zusätzlich zu den Freunden; dieser
   * Bildschirm hat den ganzen Platz, zeigt Vorschautext und Uhrzeit und
   * braucht keinen Freunde-Eintrag, weil Freunde am Telefon ein eigener
   * Bereich sind. Ein gemeinsamer Baustein hätte beide zum kleinsten
   * gemeinsamen Nenner gezwungen.
   *
   * Geteilt wird, was zählt: derselbe Store, dieselben Namensfarben, dieselbe
   * Ungelesen-Rechnung.
   *
   * Trefferliste und „Neues Gespräch" liegen daneben (`MobileChatsSuche`,
   * `NeuesGespraechDialog`) — drei unabhängige Anliegen in einer Datei waren
   * fast das Doppelte der Grössen-Grenze für Svelte-Komponenten.
   */
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import SearchIcon from '@lucide/svelte/icons/search';
  import XIcon from '@lucide/svelte/icons/x';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import BereichsKopf from './BereichsKopf.svelte';
  import MobileChatsSuche from './MobileChatsSuche.svelte';
  import NeuesGespraechDialog from './NeuesGespraechDialog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { kurzeUhrzeit } from '$lib/utils/kurzeUhrzeit';
  import { suchnorm } from '$lib/utils/suche';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    onSelect
  }: {
    onSelect: (dm: DMChannel) => void;
  } = $props();

  let neuesGespraech = $state(false);
  let suche = $state('');

  /** Ab drei ZEICHEN wird gesucht — gerechnet wird über die normalisierte
   *  Eingabe, damit „a -" noch lange keine Suche auslöst. */
  let suchbegriff = $derived.by(() => {
    const norm = suchnorm(suche.trim());
    return norm.length >= 3 ? norm : null;
  });

  // Namen und Bilder der Gegenüber in den Zwischenspeicher holen. Der Store
  // bündelt die Anfragen, mehrfaches Anmelden kostet nichts.
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });

  function initialen(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  /**
   * Der Ausschnitt unter dem Namen. Die beiden Marker aus `dm_vorschau.py`
   * werden hier zu Wörtern — der Server schickt bewusst keinen Dateinamen.
   */
  function vorschau(dm: DMChannel): string {
    const roh = dm.last_message_preview;
    if (!roh) return '';
    let text = roh;
    if (roh === '__image__') text = m.dm_preview_image();
    else if (roh === '__file__') text = m.dm_preview_file();
    // Private Nachrichten sind cloud-gebunden (`CloudOnly` im Gateway) —
    // die eigene Kennung ist deshalb die des Kontos, nicht die server-lokale.
    const vonMir = !!auth.user && dm.last_message_author_id === auth.user.id;
    return vonMir ? m.dm_preview_own_prefix() + text : text;
  }
</script>

<div
  class="glass-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  data-testid="mobile-chats-list"
>
  <BereichsKopf titel={m.nav_tab_chats()}>
    {#snippet handlung()}
      <!-- Neues Gespräch — oben rechts in der Kopfzeile, hinter einem
           Drei-Punkte-Menü: Platz für künftige Handlungen (Gruppen, Einstellungen),
           ohne die Kopfzeile erneut umzubauen. `size-12` statt `size-11`: die
           Trefferfläche wird gemessen (mobile-treffflaechen.spec.ts) und 44 px
           reissen die 48-dp-Grenze. -->
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-12 items-center justify-center rounded-[14px] transition-colors"
              data-testid="chats-menu"
              aria-label={m.chats_menu()}
            >
              <EllipsisIcon class="size-6" />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-52">
          <DropdownMenu.Item
            onclick={() => (neuesGespraech = true)}
            data-testid="chats-menu-new-chat"
            class="flex items-center gap-2"
          >
            <PencilIcon class="size-4" />
            {m.chats_compose()}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </BereichsKopf>

  <!-- Suchleiste: filtert die Gespräche lokal und durchsucht ab drei Zeichen
       die ganze DM-Historie serverseitig. -->
  <div class="px-5 pb-5" data-testid="chats-search-wrap">
    <label class="border-border bg-bg-input flex items-center gap-2 rounded-full border px-3 py-2">
      <SearchIcon class="text-text-muted size-4 shrink-0" />
      <input
        type="text"
        bind:value={suche}
        placeholder={m.chats_search_placeholder()}
        class="placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none"
        data-testid="chats-search-input"
        aria-label={m.chats_search_placeholder()}
      />
      {#if suche}
        <button
          type="button"
          onclick={() => (suche = '')}
          class="text-text-muted hover:text-text-bright shrink-0"
          data-testid="chats-search-clear"
          aria-label={m.chats_search_clear()}
        >
          <XIcon class="size-4" />
        </button>
      {/if}
    </label>
  </div>

  <nav class="flex flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-3">
    {#if suchbegriff}
      <MobileChatsSuche {suchbegriff} roheEingabe={suche} {onSelect} />
    {:else}
      {#if directMessages.list.length === 0}
        <!-- Ein leerer Bildschirm ist eine Aufforderung, keine Stimmung. Das
             Motiv ist der Ping der Bildmarke — hier als das, was er bedeutet:
             es ist noch niemand da, ruf jemanden. -->
        <div class="flex flex-col items-center px-8 pt-16 text-center" data-testid="chats-empty">
          <span class="relative mb-5 flex size-20 items-center justify-center" aria-hidden="true">
            <span class="border-primary/15 absolute size-20 rounded-full border"></span>
            <span class="border-primary/25 absolute size-14 rounded-full border"></span>
            <span class="bg-primary/30 size-2.5 rounded-full"></span>
          </span>
          <p class="text-text-bright text-sm font-semibold">{m.chats_empty_title()}</p>
          <p class="text-text-muted mt-1 text-xs leading-relaxed">{m.chats_empty()}</p>
        </div>
      {/if}
      {#each directMessages.list as dm (dm.id)}
        {@const ungelesen = readState.isUnread(dm.id)}
        {@const zahl = readState.getUnreadCount(dm.id)}
        {@const u = userCache.get(dm.other_user_id)}
        {@const bild = safeAvatarUrl(u?.avatar_url ?? null)}
        {@const name = userCache.displayName(dm.other_user_id)}
        {@const text = vorschau(dm)}
        <button
          class="hover:bg-bg-hover border-border bg-bg-input flex w-full items-center gap-3 rounded-[14px] border p-2.5 text-left transition-colors"
          onclick={() => onSelect(dm)}
          data-testid={`chat-row-${dm.id}`}
          data-unread={ungelesen}
        >
          <span class="relative size-[46px] shrink-0">
            {#if bild}
              <img src={bild} alt="" class="size-full rounded-full object-cover" />
            {:else}
              <span
                class="flex size-full items-center justify-center rounded-full text-base font-bold text-white"
                style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
                >{initialen(name)}</span
              >
            {/if}
            <StatusDot
              status={presence.displayStatusForFriend(dm.other_user_id)}
              class="ring-bg-panel absolute -right-px -bottom-px size-[13px] ring-[3px]"
            />
          </span>

          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span
                class="truncate text-sm font-semibold {ungelesen
                  ? 'text-text-bright'
                  : 'text-text-base'}"
                style={nameStyle(dm.other_user_id)}>{name}</span
              >
              {#if zahl > 0}
                <span
                  class="bg-badge-count text-2xs ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 font-extrabold leading-none text-white"
                  data-testid="chat-row-unread"
                  data-unread-count={zahl}
                  aria-label={m.nav_tab_unread_badge({ count: zahl })}
                  >{zahl > 99 ? '99+' : zahl}</span
                >
              {:else if dm.last_message_at}
                <time class="text-text-muted text-2xs ml-auto shrink-0"
                  >{kurzeUhrzeit(dm.last_message_at)}</time
                >
              {/if}
            </span>
            {#if text}
              <span
                class="block truncate text-xs {ungelesen
                  ? 'text-text-bright font-medium'
                  : 'text-text-muted'}">{text}</span
              >
            {/if}
          </span>
        </button>
      {/each}
    {/if}
  </nav>

  <NeuesGespraechDialog bind:open={neuesGespraech} {onSelect} />
</div>
