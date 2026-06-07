<script lang="ts">
  import { tick, untrack } from 'svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import AtSignIcon from '@lucide/svelte/icons/at-sign';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MessageItem from './MessageItem.svelte';
  import MessageInput from './MessageInput.svelte';
  import { plainifyMentions } from './messageRender';
  import MemberList from './MemberList.svelte';
  import ComposerDisabledBanner from './ComposerDisabledBanner.svelte';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { userCache } from '$lib/stores/users.svelte';
  import { typing } from '$lib/stores/typing.svelte';
  import { gateway, cloudGateway } from '$lib/ws/connection';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { isElectron } from '$lib/platform/runtime';
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
    cloudScoped = false,
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
    /** Global-Friends Stufe 1: DMs leben in der Cloud. Bei `true` gehen
     *  Typing-Signale über die Cloud-Connection und "ist das meine Nachricht?"
     *  vergleicht gegen die Cloud-User-ID (auth.user.id) statt gegen die
     *  aktive-Server-ID — sonst stimmt bei aktivem Self-Host weder das
     *  Typing-Ziel noch der Self-Echo-Filter. */
    cloudScoped?: boolean;
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

  // Composer instance — the whole ChatView is a file drop zone (Discord-style)
  // and forwards dropped files into the composer's pending-upload strip.
  let composer = $state<MessageInput | undefined>();
  let dragActive = $state(false);
  let dragDepth = 0; // dragenter/leave fire per child — count to stay sane

  // Drag&drop attachment upload is disabled in the Electron desktop app: a
  // sandboxed renderer loading the remote web app can't read the bytes of an
  // OS-dropped file (size 0 → upload 422 + broken blob preview). The 📎 file
  // picker grants proper access and stays the supported path there. Browsers
  // are unaffected — drop works fine.
  const dropAllowed = $derived(!!channel && !composerDisabled && !isElectron());

  function onZoneDragEnter(e: DragEvent) {
    if (!dropAllowed || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); dragDepth++; dragActive = true;
  }
  function onZoneDragOver(e: DragEvent) {
    if (dropAllowed && e.dataTransfer?.types.includes('Files')) e.preventDefault();
  }
  function onZoneDragLeave() {
    if (!dragActive) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragActive = false;
  }
  function onZoneDrop(e: DragEvent) {
    if (!dropAllowed || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); dragDepth = 0; dragActive = false;
    if (e.dataTransfer.files?.length) composer?.addExternalFiles(e.dataTransfer.files);
  }

  let scrollContainer = $state<HTMLDivElement | null>(null);
  let lastCount = $state(0);
  let memberListOpen = $state(false);

  // Eigene Identität AUF DEM AKTIVEN SERVER (Cloud-id ≠ Self-Host-id). Für jeden
  // "ist das meine Nachricht?"-Vergleich gegen server-lokale IDs — siehe
  // currentServerUser-Helfer.
  // Cloud-scoped (DM) → Cloud-User-ID (auth.user.id); sonst aktive-Server-ID.
  let myId = $derived(cloudScoped ? (auth.user?.id ?? null) : currentServerUserId());

  $effect(() => {
    const toQueue = messages
      .filter((m) => !myId || m.author_id !== myId)
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
  // Plain (non-reactive) bookkeeping for the memoization below — written from
  // inside the `messageMap` derived, so it must NOT be `$state` (Svelte 5
  // forbids mutating reactive state inside a derived → state_unsafe_mutation,
  // which aborts the render and leaves messages blank). Mirrors _cachedMessageMap.
  let _lastMapMessageIds: string[] = [];

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
  // Plain (non-reactive) — written from inside the `items` derived below.
  // See the note on _lastMapMessageIds: `$state` here throws
  // state_unsafe_mutation and blanks the message list.
  let _lastItemsMessageCount = 0;
  let _lastItemsLastMessageId = '';

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
    return { id: parent.id, author: authorName(parent), snippet: snippet(plainifyMentions(parent.content)) };
  }

  const replyBanner = $derived(
    replyTarget ? { id: replyTarget.id, author: authorName(replyTarget), snippet: snippet(plainifyMentions(replyTarget.content)) } : null
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

  // Typing indicator. The composer fires onTyping on every keystroke; we
  // debounce to one broadcast per 3s (the store keeps each user "typing" for
  // 6s, so a steady typer stays lit without spamming the channel).
  let lastTypingSent = 0;
  function notifyTyping() {
    if (!channel) return;
    const now = Date.now();
    if (now - lastTypingSent < 3000) return;
    lastTypingSent = now;
    (cloudScoped ? cloudGateway : gateway).sendTyping(channel.id);
  }

  const typingLabel = $derived.by(() => {
    const ids = typing.others(channel?.id, myId ?? undefined);
    if (ids.length === 0) return '';
    const names = ids.map((id) => userCache.displayName(id));
    if (names.length === 1) return pm.chat_view_typing_one({ name: names[0] });
    if (names.length === 2) return pm.chat_view_typing_two({ a: names[0], b: names[1] });
    return pm.chat_view_typing_many();
  });

  function canEditMessage(m: Message): boolean {
    return !!myId && m.author_id === myId && !m.id.startsWith('tmp-') && !m.deleted_at;
  }
  function canDeleteMessage(m: Message): boolean {
    if (!myId) return false;
    if (m.id.startsWith('tmp-')) return false;
    return m.author_id === myId || isOwner;
  }
  // Nur fremde Nachrichten melden (nicht die eigenen).
  function canReportMessage(m: Message): boolean {
    if (!myId) return false;
    return m.author_id !== myId;
  }
</script>

<section
  class="glass-panel relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:rounded-2xl"
  aria-label={channel ? channel.name : pm.chat_view_select_channel()}
  ondragenter={onZoneDragEnter}
  ondragover={onZoneDragOver}
  ondragleave={onZoneDragLeave}
  ondrop={onZoneDrop}
>
  {#if dragActive}
    <div
      class="bg-primary/10 border-primary text-primary pointer-events-none absolute inset-0 z-30 m-2 flex items-center justify-center rounded-2xl border-2 border-dashed text-base font-semibold backdrop-blur-sm"
      data-testid="chat-drop-overlay"
    >
      {pm.message_input_drop_files_hint()}
    </div>
  {/if}
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
    {#if typingLabel}
      <div
        class="text-text-base flex h-5 items-center gap-2 px-4 text-xs md:px-5"
        data-testid="typing-indicator"
        aria-live="polite"
      >
        <span class="typing-dots inline-flex items-center gap-1" aria-hidden="true">
          <span class="bg-primary size-1.5 rounded-full"></span>
          <span class="bg-primary size-1.5 rounded-full"></span>
          <span class="bg-primary size-1.5 rounded-full"></span>
        </span>
        <span class="truncate font-medium">{typingLabel}</span>
      </div>
    {/if}
    <MessageInput
      bind:this={composer}
      handleDrop={false}
      onTyping={notifyTyping}
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

<style>
  /* Typing indicator — three dots that ripple in sequence (Discord-style).
     Color/size/shape come from Tailwind utility classes on the spans; this
     block only carries the keyframe + staggered delays. */
  .typing-dots > span {
    animation: typing-bounce 1.3s infinite ease-in-out both;
  }
  .typing-dots > span:nth-child(1) {
    animation-delay: -0.32s;
  }
  .typing-dots > span:nth-child(2) {
    animation-delay: -0.16s;
  }
  @keyframes typing-bounce {
    0%,
    80%,
    100% {
      transform: scale(0.5);
      opacity: 0.45;
    }
    40% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .typing-dots > span {
      animation: none;
      opacity: 0.7;
    }
  }
</style>
