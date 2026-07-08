<script lang="ts">
  import { untrack } from 'svelte';
  import HashIcon from '@lucide/svelte/icons/hash';
  import AtSignIcon from '@lucide/svelte/icons/at-sign';
  import UsersIcon from '@lucide/svelte/icons/users';
  import MessageInput from './MessageInput.svelte';
  import MessageList from './MessageList.svelte';
  import MemberList from './MemberList.svelte';
  import ComposerDisabledBanner from './ComposerDisabledBanner.svelte';
  import { plainifyMentions } from './messageRender';
  import type { Channel, Message } from '$lib/api/types';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { typing } from '$lib/stores/typing.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { gateway, cloudGateway } from '$lib/ws/connection';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { isElectron } from '$lib/platform/runtime';
  import { canRecoverDroppedFiles, recoverDroppedFiles } from '$lib/platform/electronFiles';
  import { channelNameStyle } from '$lib/utils/nameColor';
  import { m as pm } from '$lib/paraglide/messages.js';

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

  // '#'-Prefix für Guild-Channels (Screenshot-Tests + Gewohnheit), '@' für DMs.
  let namePrefix = $derived(headerKind === 'dm' ? '@' : '#');

  let replyTarget = $state<Message | null>(null);

  // ChatView ist eine Drop-Zone (Discord-Style) und reicht Dateien an den Composer durch.
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

  let memberListOpen = $state(false);
  // Mitgliederliste: nur Desktop — auf Mobil komplett ausgeblendet.
  let showMemberInline = $derived(memberListOpen && !viewport.isMobile);

  // Eigene Identität AUF DEM AKTIVEN SERVER (Cloud-id ≠ Self-Host-id). Für jeden
  // "ist das meine Nachricht?"-Vergleich gegen server-lokale IDs — siehe
  // currentServerUser-Helfer.
  // Cloud-scoped (DM) → Cloud-User-ID (auth.user.id); sonst aktive-Server-ID.
  let myId = $derived(cloudScoped ? (auth.user?.id ?? null) : currentServerUserId());

  // Laufenden Drag bei Kanalwechsel abbrechen — sonst bleibt das Drop-Overlay
  // sichtbar, wenn der User während eines Drags den Kanal wechselt.
  $effect(() => {
    void channel?.id;
    untrack(() => {
      dragActive = false;
      dragDepth = 0;
    });
  });

  // Reply-Banner-Vorschau für den Composer (Author + Snippet der Zitat-Nachricht).
  // authorName/snippet werden auch in MessageList gebraucht — bewusst doppelt
  // (klein), eine spätere Dedup in eine shared utility ist möglich.
  function authorName(m: Message): string {
    if (auth.user && m.author_id === myId) {
      return auth.user.display_name ?? auth.user.username;
    }
    return userCache.displayName(m.author_id);
  }
  function snippet(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }
  const replyBanner = $derived(
    replyTarget
      ? { id: replyTarget.id, author: authorName(replyTarget), snippet: snippet(plainifyMentions(replyTarget.content)) }
      : null
  );

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
      <span class="text-text-bright truncate text-lg font-semibold tracking-tight" style={headerKind === 'dm' ? '' : channelNameStyle(channel)} data-testid="active-channel-name">{channel.name}</span>
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
    <MessageList
      {channel}
      {messages}
      {myId}
      {namePrefix}
      {isOwner}
      onSetReplyTarget={(m) => (replyTarget = m)}
      onEditMessage={onEditMessage}
      onDeleteMessage={onDeleteMessage}
      onToggleReaction={onToggleReaction}
    />

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
