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
  import { canRecoverDroppedFiles, recoverDroppedFiles } from '$lib/platform/electronFiles';
  import { safeAvatarUrl } from '$lib/avatar';
  import { nameStyle } from '$lib/utils/nameColor';
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

  // Drag&drop attachment upload. In the Electron desktop app the sandboxed
  // renderer can't read OS-dropped file bytes directly (size 0 → upload 422) —
  // but a current shell exposes a native bridge that recovers them, so drop is
  // allowed when that bridge is present (older shells stay on the 📎 picker).
  // Browsers are always on.
  const dropAllowed = $derived(
    !!channel && !composerDisabled && (!isElectron() || canRecoverDroppedFiles())
  );

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
  async function onZoneDrop(e: DragEvent) {
    if (!dropAllowed || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); dragDepth = 0; dragActive = false;
    const list = e.dataTransfer.files;
    if (!list?.length) return;
    // In Electron the dropped files arrive with 0 bytes — recover them through
    // the native bridge before handing them to the composer.
    const files = isElectron() ? await recoverDroppedFiles(list) : list;
    if (files.length) composer?.addExternalFiles(files);
  }

  let scrollContainer = $state<HTMLDivElement | null>(null);
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
      // Beim Kanalwechsel kleben wir wieder unten, bis der User selbst scrollt.
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

  function formatDividerLabel(date: Date, today: Date, yesterday: Date): string {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (d.getTime() === today.getTime()) return pm.chat_view_today();
    if (d.getTime() === yesterday.getTime()) return pm.chat_view_yesterday();
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  let messageMap = $derived(new Map(messages.map((m) => [m.id, m])));

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
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);

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
          newItems.push({ kind: 'divider', label: formatDividerLabel(mDate, today, yesterday), key: `div-${m.id}` });
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
      _cachedItems = buildItems(messages, today, yesterday);
    }

    _lastItemsMessageCount = len;
    _lastItemsLastMessageId = lastId;
    return _cachedItems;
  });

  function buildItems(msgs: Message[], today: Date, yesterday: Date): ChatItem[] {
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
        result.push({ kind: 'divider', label: formatDividerLabel(mDate, today, yesterday), key: `div-${m.id}` });
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
    // Eigene Nachrichten gegen ``myId`` matchen, NICHT gegen ``auth.user.id``:
    // im Self-Host ist die eigene ``author_id`` die server-lokale ID (pairwise),
    // nicht die Cloud-ID. ``myId`` ist DM→Cloud-ID, sonst die server-lokale ID
    // (currentServerUserId). Ohne das fällt der eigene Name auf den leeren
    // userCache durch → „…".
    if (auth.user && m.author_id === myId) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }

  function authorStyle(m: Message): string {
    // Vorrang wie in der Mitgliederliste: Rollenfarbe der Community zuerst,
    // sonst die Profilfarbe (ein- oder zweifarbig als Verlauf). nameStyle macht
    // Self-Detection + Gradient-Rendering selbst.
    return nameStyle(m.author_id, channel?.guild_id ?? null);
  }

  function avatarUrl(m: Message): string | null {
    const raw = auth.user && m.author_id === myId
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
    <div
      bind:this={scrollContainer}
      onscroll={handleScroll}
      class="flex-1 overflow-y-auto py-4"
      data-testid="message-list"
    >
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
                authorStyle={authorStyle(item.message)}
                replyTo={replyMetaFor(item.message)}
                avatarUrl={avatarUrl}
                isContinuation={item.isContinuation}
                canEdit={canEditMessage(item.message)}
                canDelete={canDeleteMessage(item.message)}
                canReport={canReportMessage(item.message)}
                onReply={(m) => (replyTarget = m)}
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
      onCancelReply={() => (replyTarget = null)}
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
