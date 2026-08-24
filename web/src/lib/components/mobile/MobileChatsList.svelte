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
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { friends } from '$lib/stores/friends.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import { goto } from '$app/navigation';
  import XIcon from '@lucide/svelte/icons/x';
  import BereichsKopf from './BereichsKopf.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { kurzeUhrzeit } from '$lib/utils/kurzeUhrzeit';
  import { suchnorm, namePasst } from '$lib/utils/suche';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import { chatApi, type DMMessageSearchHit } from '$lib/api/chat';
  import type { DMChannel } from '$lib/api/types';
  import type { Channel as ChannelTyp } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { toast } from 'svelte-sonner';

  let {
    onSelect
  }: {
    onSelect: (dm: DMChannel) => void;
  } = $props();

  // ---- Neues Gespräch: Freundesliste im Dialog statt Sprung zum Freunde-Tab.
  // Der Weg dorthin ist der_same wie in FriendList.svelte (openDM): Kanal
  // holen oder erzeugen, in den Store, Gespräch öffnen.
  let neuesGespraech = $state(false);

  /** Nur Freunde OHNE bestehendes Gespräch — mit wem schon ein Chat offen
   *  ist, steht in der Chats-Liste; hier geht es um NEUE Gespräche. */
  let freundeOhneChat = $derived.by(() => {
    const mitChat = new Set(directMessages.list.map((dm) => dm.other_user_id));
    return friends.list.filter((f) => !mitChat.has(f.user_id));
  });

  $effect(() => {
    if (neuesGespraech) for (const f of freundeOhneChat) userCache.queue(f.user_id);
  });

  async function starteDM(userId: string) {
    try {
      const dm = await chatApi.createOrGetDMChannel(userId);
      directMessages.upsert(dm);
      neuesGespraech = false;
      onSelect(dm);
      await goto(`/app/@me/${dm.id}`);
    } catch (e) {
      toast.error(m.friend_list_dm_open_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  // ---- Suche (WhatsApp-artig: Personen aus der Liste, Nachrichten aus
  // der Historie via `/dm-channels-search`) ---------------------------------
  let suche = $state('');
  let treffer = $state<DMMessageSearchHit[]>([]);
  let sucht = $state(false);

  /** Ab drei ZEICHEN wird gesucht — gerechnet wird über die normalisierte
   *  Eingabe, damit „a -" noch lange keine Suche auslöst. */
  let suchbegriff = $derived.by(() => {
    const norm = suchnorm(suche.trim());
    return norm.length >= 3 ? norm : null;
  });

  /** Gefilterte Gespräche nach Namen — lokal über den Store, kein Roundtrip.
   *  Namen mit Zahlen werden über alle drei Pfade getroffen (`namePasst`). */
  let personenTreffer = $derived(
    suchbegriff
      ? directMessages.list.filter((dm) =>
          namePasst(userCache.displayName(dm.other_user_id), suchbegriff)
        )
      : []
  );

  /** Text-Kanäle der eigenen Communities, deren Name passt. Kanäle sind pro
   *  Guild gecached; wer noch nie in einer Community war, hat nichts im
   *  Cache — daher werden sie beim ersten Suchen nachgeladen (entprellt über
   *  denselben Effekt wie die Nachrichtensuche). */
  let kanalTreffer = $derived.by(() => {
    if (!suchbegriff) return [];
    const treffer: { guild: { id: string; name: string }; kanal: ChannelTyp }[] = [];
    for (const g of guilds.list) {
      for (const c of guilds.channelsByGuild[g.id] ?? []) {
        if (c.type !== 0) continue; // nur Text-Kanäle
        if (suchnorm(c.name).includes(suchbegriff)) {
          treffer.push({ guild: { id: g.id, name: g.name }, kanal: c });
        }
      }
    }
    return treffer;
  });

  // Kanal-Cache der Communities auffüllen, sobald zum ersten Mal gesucht
  // wird — ohne das bliebe die Kanal-Suche bei Nutzern leer, die noch in
  // keiner Community unterwegs waren.
  $effect(() => {
    if (!suchbegriff) return;
    for (const g of guilds.list) {
      void guilds.ensureChannels(g.id).catch(() => undefined);
    }
  });

  // Nachrichtensuche mit 300 ms Entprellung; überholte Antworten verwerfen.
  let suchlauf = 0;
  $effect(() => {
    const q = suche.trim();
    const lauf = ++suchlauf;
    if (!suchbegriff) {
      treffer = [];
      sucht = false;
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const ergebnis = await chatApi.searchDMMessages(q);
        if (lauf === suchlauf) treffer = ergebnis;
      } catch {
        if (lauf === suchlauf) treffer = [];
      } finally {
        if (lauf === suchlauf) sucht = false;
      }
    }, 300);
    sucht = true;
    return () => clearTimeout(timer);
  });

  /** Gespräch öffnen — auch für Treffer, deren Kanal noch nicht im Store ist. */
  async function oeffneTreffer(hit: DMMessageSearchHit) {
    const bekannt = directMessages.byId[hit.dm_channel_id];
    if (bekannt) {
      onSelect(bekannt);
      return;
    }
    try {
      const dm = await chatApi.getDMChannel(hit.dm_channel_id);
      directMessages.upsert(dm);
      onSelect(dm);
    } catch {
      /* Kanal weg — Liste neu hydraten bleibt dem Store überlassen. */
    }
  }

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
           ohne die Kopfzeile erneut umzubauen. -->
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
                class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-11 items-center justify-center rounded-[14px] transition-colors"
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

  <!-- Suchleiste: filtert die Gespräche lokal und durchsucht ab zwei Zeichen
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
      <!-- Suchergebnisse: erst passende Personen, dann Nachrichtentreffer. -->
      {#if personenTreffer.length === 0 && kanalTreffer.length === 0 && treffer.length === 0 && !sucht}
        <p class="text-text-muted px-4 pt-8 text-center text-xs" data-testid="chats-search-empty">
          {m.chats_search_no_results()}
        </p>
      {/if}
      {#if personenTreffer.length > 0}
        <span class="text-text-muted px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide">
          {m.chats_search_section_people()}
        </span>
      {/if}
      {#each personenTreffer as dm (dm.id)}
        {@const name = userCache.displayName(dm.other_user_id)}
        {@const bild = safeAvatarUrl(userCache.get(dm.other_user_id)?.avatar_url ?? null)}
        <button
          class="hover:bg-bg-hover border-border bg-bg-input flex w-full items-center gap-3 rounded-[14px] border p-2.5 text-left transition-colors"
          onclick={() => onSelect(dm)}
          data-testid={`search-row-person-${dm.id}`}
        >
          <span class="size-[38px] shrink-0">
            {#if bild}
              <img src={bild} alt="" class="size-full rounded-full object-cover" />
            {:else}
              <span
                class="flex size-full items-center justify-center rounded-full text-sm font-bold text-white"
                style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
              >{initialen(name)}</span>
            {/if}
          </span>
          <span
            class="truncate text-sm font-semibold"
            style={nameStyle(dm.other_user_id)}>{name}</span
          >
        </button>
      {/each}
      {#if kanalTreffer.length > 0}
        <span class="text-text-muted px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide">
          {m.chats_search_section_channels()}
        </span>
      {/if}
      {#each kanalTreffer as t_k (t_k.kanal.id)}
        <button
          class="hover:bg-bg-hover border-border bg-bg-input flex w-full items-center gap-3 rounded-[14px] border p-2.5 text-left transition-colors"
          onclick={() => goto(`/app/guilds/${t_k.guild.id}/channels/${t_k.kanal.id}`)}
          data-testid={`search-row-channel-${t_k.kanal.id}`}
        >
          <span class="text-text-muted flex size-[38px] shrink-0 items-center justify-center rounded-full bg-bg-hover">
            <HashIcon class="size-5" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold">{t_k.kanal.name}</span>
            <span class="text-text-muted block truncate text-xs">{t_k.guild.name}</span>
          </span>
        </button>
      {/each}
      {#if treffer.length > 0 || sucht}
        <span class="text-text-muted px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide">
          {m.chats_search_section_messages()}
        </span>
      {/if}
      {#if sucht}
        <p class="text-text-muted px-4 py-3 text-xs">{m.chats_searching()}</p>
      {/if}
      {#each treffer as hit (hit.message_id)}
        {@const name = userCache.displayName(hit.other_user_id)}
        {@const vonMir = !!auth.user && hit.author_id === auth.user.id}
        <button
          class="hover:bg-bg-hover border-border bg-bg-input flex w-full flex-col gap-1 rounded-[14px] border p-2.5 text-left transition-colors"
          onclick={() => oeffneTreffer(hit)}
          data-testid={`search-row-message-${hit.message_id}`}
        >
          <span class="flex items-center gap-2">
            <span class="truncate text-sm font-semibold" style={nameStyle(hit.other_user_id)}
              >{name}</span>
            <time class="text-text-muted ml-auto shrink-0 text-2xs"
              >{kurzeUhrzeit(hit.created_at)}</time
            >
          </span>
          <span class="text-text-muted line-clamp-2 text-xs"
            >{vonMir ? m.dm_preview_own_prefix() : ''}{hit.content}</span
          >
        </button>
      {/each}
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
    {/if}
  </nav>

  <!-- Neues Gespräch: die Freunde als Liste mit Chat-Symbol — ein Tipp
       öffnet direkt das Gespräch, ohne den Umweg über den Freunde-Bereich. -->
  <Dialog.Root bind:open={neuesGespraech}>
    <Dialog.Content class="max-w-sm" data-testid="chats-new-chat-dialog">
      <Dialog.Header>
        <Dialog.Title>{m.chats_compose()}</Dialog.Title>
        <Dialog.Description>{m.chats_new_chat_hint()}</Dialog.Description>
      </Dialog.Header>
      <div class="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
        {#if freundeOhneChat.length === 0}
          <p class="text-text-muted px-2 py-6 text-center text-xs">
            {m.chats_new_chat_no_friends()}
          </p>
        {/if}
        {#each freundeOhneChat as f (f.user_id)}
          {@const name = userCache.displayName(f.user_id)}
          {@const bild = safeAvatarUrl(userCache.get(f.user_id)?.avatar_url ?? null)}
          <button
            type="button"
            class="hover:bg-bg-hover flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors"
            onclick={() => starteDM(f.user_id)}
            data-testid={`new-chat-friend-${f.user_id}`}
          >
            <span class="relative size-10 shrink-0">
              {#if bild}
                <img src={bild} alt="" class="size-full rounded-full object-cover" />
              {:else}
                <span
                  class="flex size-full items-center justify-center rounded-full text-sm font-bold text-white"
                  style="background-image: linear-gradient(135deg in oklab, var(--accent-grad-from), var(--accent-grad-to));"
                >{initialen(name)}</span>
              {/if}
              <StatusDot
                status={presence.displayStatusForFriend(f.user_id)}
                class="ring-bg-panel absolute -bottom-px -right-px size-3.5 ring-[3px]"
              />
            </span>
            <span
              class="truncate text-sm font-semibold"
              style={nameStyle(f.user_id)}>{name}</span
            >
            <MessageCircleIcon class="text-text-muted ml-auto size-5 shrink-0" />
          </button>
        {/each}
      </div>
    </Dialog.Content>
  </Dialog.Root>
</div>
