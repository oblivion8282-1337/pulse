<script lang="ts">
  import { tick, untrack } from 'svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import AtSignIcon from '@lucide/svelte/icons/at-sign';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MessageItem from './MessageItem.svelte';
  import MessageInput from './MessageInput.svelte';
  import MemberList from './MemberList.svelte';
  import ComposerDisabledBanner from './ComposerDisabledBanner.svelte';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m as pm } from '$lib/paraglide/messages.js';

  type ChatItem =
    | { kind: 'divider'; label: string; key: string }
    | { kind: 'message'; message: Message; isContinuation: boolean; key: string };

  let {
    channel,
    messages,
    onSend,
    isOwner = false,
    headerKind = 'channel',
    showMemberList = true,
    composerDisabled = false,
    composerDisabledReason = '',
    onEditMessage,
    onDeleteMessage,
    onToggleReaction
  }: {
    channel: Channel | null;
    messages: Message[];
    onSend: (text: string, replyToId: string | null, attachmentIds: string[]) => void;
    isOwner?: boolean;
    /** 'dm' swaps the # for an @-style icon and prefixes names with @. */
    headerKind?: 'channel' | 'dm';
    /** Hide the member-list toggle + inline panel (DMs have no member list). */
    showMemberList?: boolean;
    /** Lock the composer (no typing, no submit). Drives the DM hard-cut
     *  foundation — friendship lost or block in place. */
    composerDisabled?: boolean;
    composerDisabledReason?: string;
    onEditMessage: (m: Message, newContent: string) => void;
    onDeleteMessage: (m: Message) => void;
    onToggleReaction: (m: Message, emoji: string, currentlyMine: boolean) => void;
  } = $props();

  // Computed once per render — symbol shown next to the name and used in the
  // empty-state + input placeholder. Keeps the existing # prefix for guild
  // channels so screenshot tests / habits stay stable.
  let namePrefix = $derived(headerKind === 'dm' ? '@' : '#');

  let replyTarget = $state<Message | null>(null);

  let scrollContainer = $state<HTMLDivElement | null>(null);
  let lastCount = $state(0);
  let memberListOpen = $state(false);

  $effect(() => {
    const toQueue = messages
      .filter((m) => !auth.user || m.author_id !== auth.user.id)
      .map((m) => m.author_id);
    untrack(() => {
      for (const id of toQueue) userCache.queue(id);
    });
  });

  // Reset the auto-scroll counter when the channel changes — otherwise the
  // first WS push into a freshly switched channel doesn't look like an
  // "initial load" and we miss the scroll-to-bottom.
  $effect(() => {
    void channel?.id;
    untrack(() => {
      lastCount = 0;
    });
  });

  $effect(() => {
    const count = messages.length;
    if (count !== lastCount) {
      const isInitialLoad = lastCount === 0;
      lastCount = count;
      void tick().then(() => {
        const el = scrollContainer;
        if (!el) return;
        const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
        if (isInitialLoad || nearBottom) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  });

  function formatDividerLabel(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (d.getTime() === today.getTime()) return pm.chat_view_today();
    if (d.getTime() === yesterday.getTime()) return pm.chat_view_yesterday();
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Memoize messageMap to avoid rebuilding on every message push.
  // Only recompute if the set of message IDs changes meaningfully.
  let _cachedMessageMap: Map<string, Message> | null = null;
  let _lastMapMessageIds = $state<string[]>([]);

  let messageMap = $derived.by(() => {
    const currentIds = messages.map(m => m.id);
    // Only rebuild if the number of messages or any existing ID changed
    // (edit/delete scenarios). For append-only, check length first.
    if (
      _cachedMessageMap === null ||
      currentIds.length !== _lastMapMessageIds.length ||
      currentIds.some((id, i) => id !== _lastMapMessageIds[i])
    ) {
      _cachedMessageMap = new Map(messages.map(m => [m.id, m]));
      _lastMapMessageIds = currentIds;
    }
    return _cachedMessageMap;
  });

  // Memoize buildItems to avoid full rebuild on simple appends.
  let _cachedItems: ChatItem[] | null = null;
  let _lastItemsMessageCount = $state(0);
  let _lastItemsLastMessageId = $state('');

  let items = $derived.by(() => {
    const len = messages.length;
    const lastId = len > 0 ? messages[len - 1].id : '';

    // If only new messages were appended (tail unchanged), append only the new items.
    if (
      _cachedItems !== null &&
      len > _lastItemsMessageCount &&
      _lastItemsLastMessageId === (messages[_lastItemsMessageCount - 1]?.id ?? '')
    ) {
      // Append mode: only rebuild items for new messages at the end
      const newItems: ChatItem[] = [];
      for (let i = _lastItemsMessageCount; i < len; i++) {
        const m = messages[i];
        const prev = messages[i - 1];
        const mDate = new Date(m.created_at);
        const mDateStr = mDate.toDateString();
        const prevDate = prev ? new Date(prev.created_at) : null;
        const prevDateStr = prevDate ? prevDate.toDateString() : null;

        if (!prevDate || mDateStr !== prevDateStr) {
          newItems.push({ kind: 'divider', label: formatDividerLabel(mDate), key: `div-${m.id}` });
        }

        const isContinuation =
          !!prev &&
          m.author_id === prev.author_id &&
          mDate.getTime() - prevDate!.getTime() < 7 * 60 * 1000 &&
          mDateStr === prevDateStr;

        newItems.push({ kind: 'message', message: m, isContinuation, key: m.id });
      }
      _cachedItems = [..._cachedItems, ...newItems];
    } else {
      // Edit/delete/restructure: full rebuild
      _cachedItems = buildItems(messages);
    }

    _lastItemsMessageCount = len;
    _lastItemsLastMessageId = lastId;
    return _cachedItems;
  });

  function buildItems(msgs: Message[]): ChatItem[] {
    const result: ChatItem[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const prev = msgs[i - 1];
      const mDate = new Date(m.created_at);
      const mDateStr = mDate.toDateString();
      const prevDate = prev ? new Date(prev.created_at) : null;
      const prevDateStr = prevDate ? prevDate.toDateString() : null;

      // Date divider when day changes
      if (!prevDate || mDateStr !== prevDateStr) {
        result.push({ kind: 'divider', label: formatDividerLabel(mDate), key: `div-${m.id}` });
      }

      // Continuation: same author, within 7 min, no divider separating them
      const isContinuation =
        !!prev &&
        m.author_id === prev.author_id &&
        mDate.getTime() - prevDate!.getTime() < 7 * 60 * 1000 &&
        mDateStr === prevDateStr;

      result.push({ kind: 'message', message: m, isContinuation, key: m.id });
    }
    return result;
  }

  function authorName(m: Message): string {
    if (auth.user && m.author_id === auth.user.id) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }

  function avatarUrl(m: Message): string | null {
    const raw = auth.user && m.author_id === auth.user.id
      ? auth.user.avatar_url
      : (userCache.get(m.author_id)?.avatar_url ?? null);
    return safeAvatarUrl(raw);
  }

  // Mitgliederliste: nur Desktop — auf Mobil komplett ausgeblendet.
  let showMemberInline = $derived(memberListOpen && !viewport.isMobile);

  function snippet(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  function replyMetaFor(m: Message): { id: string; author: string; snippet: string } | null {
    if (!m.reply_to_id) return null;
    const parent = messageMap.get(m.reply_to_id);
    if (!parent) {
      // Parent isn't loaded (older than our window or deleted) — show a stub.
      return { id: m.reply_to_id, author: '…', snippet: pm.chat_view_older_message() };
    }
    return { id: parent.id, author: authorName(parent), snippet: snippet(parent.content) };
  }

  const replyBanner = $derived(
    replyTarget ? { id: replyTarget.id, author: authorName(replyTarget), snippet: snippet(replyTarget.content) } : null
  );

  function startReply(m: Message) {
    replyTarget = m;
  }
  function cancelReply() {
    replyTarget = null;
  }
  function jumpToReply(parentId: string) {
    const el = scrollContainer?.querySelector(`[data-message-id="${parentId}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-primary');
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 1500);
    }
  }

  function handleSend(text: string, attachmentIds: string[]) {
    const target = replyTarget;
    onSend(text, target?.id ?? null, attachmentIds);
    replyTarget = null;
  }

  function canEditMessage(m: Message): boolean {
    return !!auth.user && m.author_id === auth.user.id && !m.id.startsWith('tmp-') && !m.deleted_at;
  }
  function canDeleteMessage(m: Message): boolean {
    if (!auth.user) return false;
    if (m.id.startsWith('tmp-')) return false;
    return m.author_id === auth.user.id || isOwner;
  }
  // Nur fremde Nachrichten melden (nicht die eigenen).
  function canReportMessage(m: Message): boolean {
    if (!auth.user) return false;
    return m.author_id !== auth.user.id;
  }
</script>

<section class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl">
  <header class="flex h-14 items-center gap-2.5 px-3 md:px-5">
    {#if channel}
      {#if headerKind === 'dm'}
        <AtSignIcon class="text-primary size-5 shrink-0" />
      {:else}
        <HashIcon class="text-primary size-5 shrink-0" />
      {/if}
      <span class="text-text-bright truncate text-lg font-semibold tracking-tight" data-testid="active-channel-name">{channel.name}</span>
      {#if channel.topic}
        <span class="text-text-muted ml-2 hidden truncate text-sm md:block">· {channel.topic}</span>
      {/if}
      {#if showMemberList}
        <button
          class="ml-auto rounded-full p-2.5 transition-colors md:p-2 hover:bg-bg-hover hover:text-primary max-md:hidden"
          onclick={() => (memberListOpen = !memberListOpen)}
          aria-label={pm.chat_view_toggle_member_list()}
          data-testid="member-list-toggle"
        >
          <UsersIcon class="text-text-muted size-4" />
        </button>
      {/if}
    {:else}
      <span class="text-text-muted text-sm">{pm.chat_view_select_channel()}</span>
    {/if}
  </header>

  <div class="relative flex min-h-0 flex-1">
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto py-4" data-testid="message-list">
      {#if channel}
        {#if messages.length === 0}
          <p class="text-text-muted px-4 py-8 text-center text-sm">
            {pm.chat_view_no_messages_prefix()}<strong class="text-text-bright">{namePrefix}{channel.name}</strong>{pm.chat_view_no_messages_suffix()}
          </p>
        {:else}
          {#each items as item (item.key)}
            {#if item.kind === 'divider'}
              <div class="mx-5 my-4 flex items-center gap-3" data-testid="date-divider">
                <div class="h-px flex-1 bg-border"></div>
                <span class="bg-bg-input text-text-muted rounded-full px-3 py-0.5 text-xs font-semibold">{item.label}</span>
                <div class="h-px flex-1 bg-border"></div>
              </div>
            {:else}
              <MessageItem
                message={item.message}
                authorName={authorName(item.message)}
                replyTo={replyMetaFor(item.message)}
                avatarUrl={avatarUrl}
                isContinuation={item.isContinuation}
                canEdit={canEditMessage(item.message)}
                canDelete={canDeleteMessage(item.message)}
                canReport={canReportMessage(item.message)}
                onReply={startReply}
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

    <!-- Inline auf md+ -->
    {#if channel && showMemberList && showMemberInline}
      <MemberList guildId={channel.guild_id} />
    {/if}

  </div>

  {#if channel}
    {#if composerDisabled && composerDisabledReason}
      <ComposerDisabledBanner reason={composerDisabledReason} />
    {/if}
    <MessageInput
      channelId={channel.id}
      placeholder={viewport.isMobile
        ? `${namePrefix}${channel.name}`
        : pm.chat_view_message_placeholder({ preposition: headerKind === 'dm' ? pm.chat_view_placeholder_to() : pm.chat_view_placeholder_in(), prefix: namePrefix, name: channel.name })}
      onSend={handleSend}
      replyTo={replyBanner}
      onCancelReply={cancelReply}
      disabled={composerDisabled}
      disabledReason={composerDisabledReason}
    />
  {/if}
</section>
