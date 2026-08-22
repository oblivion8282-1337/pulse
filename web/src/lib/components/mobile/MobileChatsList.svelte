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
   */
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import { auth } from '$lib/stores/auth.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { kurzeUhrzeit } from '$lib/utils/kurzeUhrzeit';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    onSelect,
    onCompose
  }: {
    onSelect: (dm: DMChannel) => void;
    onCompose: () => void;
  } = $props();

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
    const text =
      roh === '__image__'
        ? m.dm_preview_image()
        : roh === '__file__'
          ? m.dm_preview_file()
          : roh;
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
  <header class="text-text-bright shrink-0 px-4 pb-2 pt-3.5">
    <h1 class="text-[22px] font-extrabold tracking-tight">{m.nav_tab_chats()}</h1>
  </header>

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3">
    {#if directMessages.list.length === 0}
      <p class="text-text-muted px-3 py-6 text-center text-sm">{m.chats_empty()}</p>
    {/if}
    {#each directMessages.list as dm (dm.id)}
      {@const ungelesen = readState.isUnread(dm.id)}
      {@const zahl = readState.getUnreadCount(dm.id)}
      {@const u = userCache.get(dm.other_user_id)}
      {@const bild = safeAvatarUrl(u?.avatar_url ?? null)}
      {@const name = userCache.displayName(dm.other_user_id)}
      {@const text = vorschau(dm)}
      <button
        class="hover:bg-bg-hover flex w-full items-center gap-3 rounded-[14px] p-2.5 text-left transition-colors"
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
            >{initialen(name)}</span>
          {/if}
          <StatusDot
            status={presence.displayStatusForFriend(dm.other_user_id)}
            class="ring-bg-panel absolute -bottom-px -right-px size-[13px] ring-[3px]"
          />
        </span>

        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span
              class="truncate text-sm font-semibold {ungelesen
                ? 'text-text-bright'
                : 'text-text-base'}"
              style={nameStyle(dm.other_user_id)}
            >{name}</span>
            {#if zahl > 0}
              <span
                class="bg-badge-count ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-2xs font-extrabold leading-none text-white"
                data-testid="chat-row-unread"
                data-unread-count={zahl}
                aria-label={m.nav_tab_unread_badge({ count: zahl })}
              >{zahl > 99 ? '99+' : zahl}</span>
            {:else if dm.last_message_at}
              <time class="text-text-muted ml-auto shrink-0 text-2xs"
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
  </nav>

  <!-- Neues Gespräch. Sitzt über der Bereichs-Leiste, nicht darunter — der
       Daumen erreicht die untere rechte Ecke am leichtesten. -->
  <button
    class="accent-gradient absolute bottom-4 right-4 flex size-[52px] items-center justify-center rounded-[16px] text-white shadow-[0_10px_22px_-6px_rgba(37,99,235,.7)]"
    onclick={onCompose}
    data-testid="chats-compose"
    aria-label={m.chats_compose()}
  >
    <PencilIcon class="size-5" />
  </button>
</div>
