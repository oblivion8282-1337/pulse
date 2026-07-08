<script lang="ts">
  import { tick, untrack } from 'svelte';
  import MessageItem from './MessageItem.svelte';
  import { plainifyMentions } from './messageRender';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m as pm } from '$lib/paraglide/messages.js';

  type ChatItem =
    | { kind: 'divider'; label: string; key: string }
    | { kind: 'message'; message: Message; isContinuation: boolean; key: string };

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

  let scrollContainer = $state<HTMLDivElement | null>(null);
  let contentEl = $state<HTMLDivElement | null>(null);
  let lastCount = $state(0);
  // Ob der User aktuell ganz unten an der Liste klebt. Wird LAUFEND beim
  // Scrollen aktualisiert — also BEVOR eine neue Nachricht die Liste höher
  // macht. Neue Nachrichten wachsen den Container nach unten, ohne ein
  // scroll-Event auszulösen, d.h. dieser Wert bleibt korrekt erhalten.
  let pinnedToBottom = $state(true);

  function handleScroll() {
    const el = scrollContainer;
    if (!el) return;
    pinnedToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  }

  // Avatare/Namen fremder Autoren vorab in den Cache laden.
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
  $effect(() => {
    void channel?.id;
    untrack(() => {
      lastCount = 0;
      pinnedToBottom = true;
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
      void tick().then(() => {
        const el = scrollContainer;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
      });
    }
  });

  // Async-Inhalt (Avatare, Bilder, Link-Vorschauen, Embeds) lädt NACH dem
  // ersten Scroll und wächst den Container — sonst landet "scroll to bottom"
  // "in der Mitte". Solange der User unten klebt, bei jeder Höhenänderung
  // erneut ans Ende ziehen.
  $effect(() => {
    const content = contentEl;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const el = scrollContainer;
      if (el && pinnedToBottom) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  });

  function formatDividerLabel(date: Date, today: Date, yesterday: Date): string {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (d.getTime() === today.getTime()) return pm.chat_view_today();
    if (d.getTime() === yesterday.getTime()) return pm.chat_view_yesterday();
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  let messageMap = $derived(new Map(messages.map((m) => [m.id, m])));

  // Append-Cache: vermeidet vollen Rebuild bei einfachen Appends. Plain (nicht
  // `$state`) — würden sie in einem `$derived` geschrieben, wirft Svelte
  // state_unsafe_mutation und leert die Liste. `_lastItemsDayKey` erzwingt bei
  // Tageswechsel (Tab über Mitternacht offen) einen Rebuild, da sonst die
  // "Heute"/"Gestern"-Labels auf bestehenden Dividern veralten.
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

  function jumpToReply(parentId: string) {
    const el = scrollContainer?.querySelector(`[data-message-id="${parentId}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-primary');
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1500);
    }
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

<div
  bind:this={scrollContainer}
  onscroll={handleScroll}
  class="flex-1 overflow-y-auto py-4"
  data-testid="message-list"
>
  <div bind:this={contentEl}>
    {#if channel}
      {#if messages.length === 0}
        <p class="text-text-muted px-4 py-8 text-center text-sm">
          {pm.chat_view_no_messages_prefix()}<strong class="text-text-bright">{namePrefix}{channel.name}</strong>{pm.chat_view_no_messages_suffix()}
        </p>
      {:else}
        {#each items as item (item.key)}
          {#if item.kind === 'divider'}
            <div class="mx-5 my-4 flex items-center gap-3" data-testid="date-divider">
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
              canEdit={canEditMessage(item.message)}
              canDelete={canDeleteMessage(item.message)}
              canReport={canReportMessage(item.message)}
              onReply={onSetReplyTarget}
              onEditSubmit={onEditMessage}
              onDelete={onDeleteMessage}
              onToggleReaction={onToggleReaction}
              onJumpToReply={jumpToReply}
            />
          {/if}
        {/each}
      {/if}
    {/if}
  </div>
</div>
