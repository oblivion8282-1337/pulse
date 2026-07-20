<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { VList, type VListHandle } from 'virtua/svelte';
  import MessageItem from './MessageItem.svelte';
  import { plainifyMentions } from './messageRender';
  import { chatApi } from '$lib/api/chat';
  import { messages as messageStore } from '$lib/stores/messages.svelte';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m as pm } from '$lib/paraglide/messages.js';

  type ChatItem =
    | { kind: 'divider'; label: string; key: string }
    | { kind: 'message'; message: Message; isContinuation: boolean; key: string };

  // Infinite-Scroll-Up: ab diesem Abstand zum oberen Rand ältere nachladen.
  const LOAD_THRESHOLD = 600;
  const OLDER_PAGE = 100; // Backend-Routen-Max für /messages

  let {
    channel,
    messages,
    myId,
    namePrefix = '#',
    isOwner = false,
    onSetReplyTarget,
    onEditMessage,
    onDeleteMessage,
    onToggleReaction
  }: {
    channel: Channel | null;
    messages: Message[];
    /** Server-local id (DMs → Cloud-id) for "is this mine?" checks. */
    myId: string | null;
    namePrefix?: string;
    isOwner?: boolean;
    onSetReplyTarget: (m: Message) => void;
    onEditMessage: (m: Message, newContent: string) => void;
    onDeleteMessage: (m: Message) => void;
    onToggleReaction: (m: Message, emoji: string, currentlyMine: boolean) => void;
  } = $props();

  // Nur Guild-Channel paginieren — DMs haben selten tiefe Historie und laufen
  // cloud-scoped (default route reicht für Guild; DM bräuchte Cloud-route).
  const canPaginate = $derived(!!channel?.guild_id);

  let vlist = $state<VListHandle>();
  // Wrapper um <VList> — Viewport-Resize (Fenster/Mobile/Memberlist-Toggle)
  // und async Content-Load (Bilder/Embeds) werden hierüber beobachtet.
  let wrapperEl = $state<HTMLDivElement | null>(null);
  let lastCount = $state(0);
  // Ob der User aktuell ganz unten an der Liste klebt. Wird LAUFEND beim
  // Scrollen aktualisiert — also BEVOR eine neue Nachricht die Liste höher
  // macht. Neue Nachrichten wachsen den Container nach unten, ohne ein
  // scroll-Event auszulösen, d.h. dieser Wert bleibt korrekt erhalten.
  let pinnedToBottom = $state(true);
  // Kurzzeitig zu highlightende Nachricht (z.B. nach jumpToReply).
  let highlightId = $state<string | null>(null);
  // Infinite-Scroll-Up-State.
  let hasMore = $state(true); // es könnte ältere Historie geben
  let loadingOlder = $state(false);
  // VList `shift` MUSS pro Update stimmen, nicht statisch sein: true weist virtua
  // an, die Längenänderung als *Prepend am Anfang* zu behandeln (Scroll-Position
  // bleibt auf der aktuellen Nachricht). Für JEDE andere Änderung — neue
  // Nachricht am Ende, Löschen — MUSS es false sein, sonst deutet virtua sie als
  // Start-Mutation: der index-basierte Size-Cache verrutscht (Nachrichten
  // überlappen) und falsche Items gelten als „unmeasured" → `visibility:hidden`,
  // wodurch Inhalt/Bilder unsichtbar bleiben. Nur `loadOlder()` (der einzige
  // Prepend-Pfad) schaltet es kurzzeitig true.
  let prependShift = $state(false);

  function handleVirtuaScroll(offset: number) {
    if (!vlist) return;
    const size = vlist.getScrollSize();
    // Vor dem ersten echten Inhalt ist die Größe 0 → nicht auswerten.
    if (size === 0) return;
    pinnedToBottom = offset + vlist.getViewportSize() >= size - 80;
    if (
      canPaginate &&
      hasMore &&
      !loadingOlder &&
      messages.length > 0 &&
      offset < LOAD_THRESHOLD
    ) {
      void loadOlder();
    }
  }

  function pinToEnd() {
    if (items.length > 0) vlist?.scrollToIndex(items.length - 1, { align: 'end' });
  }

  // Ältere Historie via ?before=<älteste-id> nachladen und vorne einfügen.
  // VList `shift` hält die Scroll-Position (User bleibt auf seiner Nachricht).
  async function loadOlder() {
    if (!channel) return;
    const oldest = messages[0]?.id;
    if (!oldest) return;
    loadingOlder = true;
    try {
      const older = await chatApi.listMessages(channel.id, { before: oldest, limit: OLDER_PAGE });
      // shift NUR für diese eine Prepend-Längenänderung aktivieren, dann sofort
      // wieder deaktivieren — virtua liest den Wert im Moment, in dem `items`
      // (und damit data.length) wächst, also innerhalb des tick()-Flushes.
      prependShift = true;
      const added = messageStore.prepend(channel.id, older);
      await tick();
      prependShift = false;
      // Historie-Ende: nichts Neues kam dazu, oder die Seite war unvollständig.
      if (!added || older.length < OLDER_PAGE) hasMore = false;
    } catch {
      // Netzwerkfehler → still,Retry beim nächsten Scroll.
    } finally {
      loadingOlder = false;
    }
  }

  // Avatare/Namen fremder Autoren vorab in den Cache laden. Die Autor-IDs
  // MÜSSEN außerhalb von untrack() gelesen werden — sonst hat der Effekt keine
  // Dependency, läuft genau einmal (oft vor dem History-Load) und Autoren aus
  // WS-Pushes/Scroll-Up-Historie bekommen nie einen Namen (Regression 2f4664d5).
  $effect(() => {
    const toQueue = messages
      .filter((m) => !myId || m.author_id !== myId)
      .map((m) => m.author_id);
    untrack(() => {
      for (const id of toQueue) userCache.queue(id);
    });
  });

  // Reset beim Kanalwechsel — sonst sieht der erste WS-Push in einen frisch
  // gewechselten Channel nicht wie ein "initial load" aus → kein scroll-to-bottom.
  // VList behält den internen Offset beim data-Tausch → explizit auf 0 setzen.
  $effect(() => {
    void channel?.id;
    untrack(() => {
      lastCount = 0;
      pinnedToBottom = true;
      hasMore = true;
      loadingOlder = false;
      vlist?.scrollToIndex(0);
    });
  });

  $effect(() => {
    const count = messages.length;
    if (count !== lastCount) {
      const isInitialLoad = lastCount === 0;
      // "Klebt der User unten?" wird VOR dem DOM-Wachstum bestimmt (über den
      // laufenden Scroll-Handler) — nicht erst nach tick(), wenn die neue,
      // u.U. >80px hohe Nachricht die Messung schon verfälscht hätte.
      const shouldScroll = isInitialLoad || pinnedToBottom;
      lastCount = count;
      if (!shouldScroll) return;
      void tick().then(() => pinToEnd());
    }
  });

  // Async-Inhalt (Avatare, Bilder, Link-Vorschauen, Embeds) lädt NACH dem
  // ersten Scroll und wächst die gemessenen Item-Höhen — sonst rutscht man
  // "nach oben weg". Solange der User unten klebt, bei Viewport-Resize
  // (ResizeObserver) UND bei nachgeladenem Content (capture-'load' für
  // img/iframe) erneut ans Ende ziehen.
  $effect(() => {
    const el = wrapperEl;
    if (!el) return;
    const onGrow = () => { if (pinnedToBottom) pinToEnd(); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onGrow);
    ro?.observe(el);
    el.addEventListener('load', onGrow, true);
    return () => {
      ro?.disconnect();
      el.removeEventListener('load', onGrow, true);
    };
  });

  function formatDividerLabel(date: Date, today: Date, yesterday: Date): string {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (d.getTime() === today.getTime()) return pm.chat_view_today();
    if (d.getTime() === yesterday.getTime()) return pm.chat_view_yesterday();
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const getKey = (item: ChatItem): string => item.key;

  let messageMap = $derived(new Map(messages.map((m) => [m.id, m])));

  // Append-Cache: vermeidet vollen Rebuild bei einfachen Appends. Plain (nicht
  // `$state`) — würden sie in einem `$derived` geschrieben, wirft Svelte
  // state_unsafe_mutation und leert die Liste. `_lastItemsDayKey` erzwingt bei
  // Tageswechsel (Tab über Mitternacht offen) einen Rebuild, da sonst die
  // "Heute"/"Gestern"-Labels auf bestehenden Dividern veralten. Ein Prepend
  // (Infinite-Scroll-Up) verändert den Tail → löst sicher den Full-Rebuild aus.
  let _cachedItems: ChatItem[] | null = null;
  let _lastItemsMessageCount = 0;
  let _lastItemsLastMessageId = '';
  let _lastItemsDayKey = 0;

  let items = $derived.by(() => {
    const len = messages.length;
    const lastId = len > 0 ? messages[len - 1].id : '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const dayKey = today.getTime();

    // Append-Optimierung: wenn nur Nachrichten ans Ende kamen (Tail unverändert),
    // nur die neuen Items bauen statt die ganze Liste neu aufzubauen.
    const canAppend =
      _cachedItems !== null &&
      dayKey === _lastItemsDayKey &&
      len > _lastItemsMessageCount &&
      _lastItemsLastMessageId === (messages[_lastItemsMessageCount - 1]?.id ?? '');

    if (canAppend) {
      const newItems: ChatItem[] = [];
      for (let i = _lastItemsMessageCount; i < len; i++) {
        newItems.push(...buildItem(messages[i], messages[i - 1], today, yesterday));
      }
      _cachedItems = [..._cachedItems!, ...newItems];
    } else {
      _cachedItems = buildItems(messages, today, yesterday);
    }

    _lastItemsMessageCount = len;
    _lastItemsLastMessageId = lastId;
    _lastItemsDayKey = dayKey;
    return _cachedItems;
  });

  function buildItems(msgs: Message[], today: Date, yesterday: Date): ChatItem[] {
    const result: ChatItem[] = [];
    for (let i = 0; i < msgs.length; i++) {
      result.push(...buildItem(msgs[i], msgs[i - 1], today, yesterday));
    }
    return result;
  }

  /** Baut Divider (falls Tageswechsel) + Message-Item für eine einzelne Nachricht. */
  function buildItem(m: Message, prev: Message | undefined, today: Date, yesterday: Date): ChatItem[] {
    const mDate = new Date(m.created_at);
    const mDateStr = mDate.toDateString();
    const prevDate = prev ? new Date(prev.created_at) : null;
    const prevDateStr = prevDate ? prevDate.toDateString() : null;

    const out: ChatItem[] = [];
    if (!prevDate || mDateStr !== prevDateStr) {
      out.push({ kind: 'divider', label: formatDividerLabel(mDate, today, yesterday), key: `div-${m.id}` });
    }

    const isContinuation =
      !!prev &&
      m.author_id === prev.author_id &&
      mDate.getTime() - prevDate!.getTime() < 7 * 60 * 1000 &&
      mDateStr === prevDateStr;

    out.push({ kind: 'message', message: m, isContinuation, key: m.id });
    return out;
  }

  function authorName(m: Message): string {
    if (auth.user && m.author_id === myId) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }

  function authorStyle(m: Message): string {
    return nameStyle(m.author_id, channel?.guild_id ?? null);
  }

  function avatarUrl(m: Message): string | null {
    const raw =
      auth.user && m.author_id === myId
        ? auth.user.avatar_url
        : (userCache.get(m.author_id)?.avatar_url ?? null);
    return safeAvatarUrl(raw);
  }

  function snippet(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  function replyMetaFor(m: Message): { id: string; author: string; snippet: string } | null {
    if (!m.reply_to_id) return null;
    const parent = messageMap.get(m.reply_to_id);
    if (!parent) {
      return { id: m.reply_to_id, author: '…', snippet: pm.chat_view_older_message() };
    }
    return { id: parent.id, author: authorName(parent), snippet: snippet(plainifyMentions(parent.content)) };
  }

  // Virtualisierungssicher: index-basiert statt querySelector (das Ziel ist
  // evtl. gar nicht gemountet). Highlight läuft reaktiv über `highlightId`,
  // greift also automatisch sobald VList das Ziel nach dem Scroll mountet.
  function jumpToReply(parentId: string) {
    const idx = items.findIndex((it) => it.kind === 'message' && it.message.id === parentId);
    if (idx < 0 || !vlist) return;
    vlist.scrollToIndex(idx, { align: 'center' });
    highlightId = parentId;
    setTimeout(() => { if (highlightId === parentId) highlightId = null; }, 1500);
  }

  function canEditMessage(m: Message): boolean {
    return !!myId && m.author_id === myId && !m.id.startsWith('tmp-') && !m.deleted_at;
  }
  function canDeleteMessage(m: Message): boolean {
    if (!myId) return false;
    if (m.id.startsWith('tmp-')) return false;
    return m.author_id === myId || isOwner;
  }
  function canReportMessage(m: Message): boolean {
    if (!myId) return false;
    return m.author_id !== myId;
  }
</script>

<div class="flex-1 min-h-0" bind:this={wrapperEl} data-testid="message-list">
  {#if channel}
    {#if messages.length === 0}
      <!-- `{' '}` statt eines Leerzeichens am Ende des Textbausteins: dort wäre es
           bei der Durchsicht unsichtbar, fiele Formatierern zum Opfer und ginge
           Übersetzern verloren. Genau so entstand „…Nachrichten in#general". -->
      <p class="text-text-muted px-4 py-8 text-center text-sm">
        {pm.chat_view_no_messages_prefix()}{' '}<strong class="text-text-bright"
          >{namePrefix}{channel.name}</strong
        >{pm.chat_view_no_messages_suffix()}
      </p>
    {:else}
      <VList data={items} {getKey} bind:this={vlist} onscroll={handleVirtuaScroll} shift={prependShift} style="height:100%">
        {#snippet children(item)}
          {#if item.kind === 'divider'}
            <div class="mx-5 py-4 flex items-center gap-3" data-testid="date-divider">
              <div class="hairline flex-1 bg-border"></div>
              <span class="bg-bg-input text-text-muted rounded-full px-3 py-0.5 text-xs font-semibold">{item.label}</span>
              <div class="hairline flex-1 bg-border"></div>
            </div>
          {:else}
            <MessageItem
              message={item.message}
              authorName={authorName(item.message)}
              authorStyle={authorStyle(item.message)}
              replyTo={replyMetaFor(item.message)}
              avatarUrl={avatarUrl}
              isContinuation={item.isContinuation}
              highlight={highlightId === item.message.id}
              canEdit={canEditMessage(item.message)}
              canDelete={canDeleteMessage(item.message)}
              canReport={canReportMessage(item.message)}
              isDirect={!channel?.guild_id}
              onReply={onSetReplyTarget}
              onEditSubmit={onEditMessage}
              onDelete={onDeleteMessage}
              onToggleReaction={onToggleReaction}
              onJumpToReply={jumpToReply}
            />
          {/if}
        {/snippet}
      </VList>
    {/if}
  {/if}
</div>
