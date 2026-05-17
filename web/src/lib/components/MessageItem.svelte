<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Message } from '$lib/api/types';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
  import MessageActions from './MessageActions.svelte';
  import MessageAttachments from './MessageAttachments.svelte';
  import MessageReactions from './MessageReactions.svelte';

  const ALLOWED_TAGS = ['b', 'i', 'em', 'strong', 'code', 'pre', 'del', 's',
    'a', 'ul', 'ol', 'li', 'br', 'p', 'blockquote'];
  const ALLOWED_ATTR = ['href', 'title', 'target', 'rel'];

  DOMPurify.removeHook('afterSanitizeAttributes');
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  function renderSafe(text: string): string {
    // Pass options per-call instead of `marked.use({...})` so we don't mutate
    // the global parser config — other code (tests, HMR, future imports) won't
    // unexpectedly inherit `breaks: true`.
    const html = marked.parse(text, { breaks: true }) as string;
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      FORCE_BODY: true,
      ALLOW_DATA_ATTR: false
    });
  }

  let {
    message,
    authorName,
    replyTo,
    avatarUrl = () => null,
    isContinuation = false,
    canEdit,
    canDelete,
    onReply,
    onEditSubmit,
    onDelete,
    onToggleReaction,
    onJumpToReply
  }: {
    message: Message;
    authorName: string;
    replyTo?: { id: string; author: string; snippet: string } | null;
    avatarUrl?: (m: Message) => string | null;
    isContinuation?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    onReply: (m: Message) => void;
    onEditSubmit: (m: Message, newContent: string) => void;
    onDelete: (m: Message) => void;
    onToggleReaction: (m: Message, emoji: string, currentlyMine: boolean) => void;
    onJumpToReply?: (parentId: string) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');

  const time = $derived(formatTime(message.created_at));
  const url = $derived(avatarUrl(message));
  const html = $derived(renderSafe(message.content));
  const reactions = $derived(message.reactions ?? []);
  const attachments = $derived(message.attachments ?? []);
  const isEdited = $derived(!!message.edited_at);

  function formatTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function startEdit() {
    draft = message.content;
    editing = true;
  }
  function cancelEdit() {
    editing = false;
    draft = '';
  }
  function saveEdit() {
    const v = draft.trim();
    if (!v || v === message.content) {
      cancelEdit();
      return;
    }
    onEditSubmit(message, v);
    editing = false;
  }
  function onEditKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    }
  }

  function handleToggle(emoji: string, mine: boolean) {
    onToggleReaction(message, emoji, mine);
  }
</script>

{#snippet body()}
  {#if replyTo}
    <button
      type="button"
      class="text-text-muted hover:text-text-bright mb-0.5 flex max-w-full items-center gap-1 text-xs"
      onclick={() => onJumpToReply?.(replyTo!.id)}
      data-testid="message-reply-quote"
    >
      <CornerDownRightIcon class="size-3 shrink-0" />
      <span class="font-semibold">{replyTo.author}</span>
      <span class="text-text-muted/70 truncate">{replyTo.snippet}</span>
    </button>
  {/if}
  {#if editing}
    <textarea
      bind:value={draft}
      onkeydown={onEditKey}
      rows="2"
      class="text-text-bright w-full rounded-lg border border-border bg-bg-input px-2 py-1 text-[15px] outline-none focus:border-primary"
      data-testid="message-edit-input"
    ></textarea>
    <div class="text-text-muted mt-0.5 text-[10px]">
      Enter zum Speichern · Esc zum Abbrechen
    </div>
  {:else}
    {#if message.content}
      <div class="text-text-base break-words text-[15px]" data-testid="message-content">
        {@html html}
        {#if isEdited}
          <span class="text-text-muted text-[10px]" title={message.edited_at ?? ''}>(bearbeitet)</span>
        {/if}
      </div>
    {/if}
    <MessageAttachments {attachments} />
    <MessageReactions reactions={reactions} onToggle={handleToggle} />
  {/if}
{/snippet}

{#if isContinuation}
  <div
    class="group relative mx-2 flex gap-3 rounded-2xl px-3 py-0.5 transition-colors hover:bg-bg-hover"
    data-testid="message-item"
    data-message-id={message.id}
  >
    <div class="flex w-10 shrink-0 items-center justify-end">
      <span class="text-text-muted hidden text-[10px] group-hover:block">{time}</span>
    </div>
    <div class="min-w-0 flex-1">
      {@render body()}
    </div>
    {#if !editing}
      <MessageActions
        {canEdit}
        {canDelete}
        onReply={() => onReply(message)}
        onEdit={startEdit}
        onDelete={() => onDelete(message)}
        onReact={(e) => handleToggle(e, false)}
      />
    {/if}
  </div>
{:else}
  <div
    class="group relative mx-2 flex gap-3 rounded-2xl px-3 py-1.5 transition-colors hover:bg-bg-hover"
    data-testid="message-item"
    data-message-id={message.id}
  >
    {#key url}
      <Avatar.Root class="size-10 shrink-0">
        {#if url}
          <Avatar.Image src={url} alt={authorName} />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
          {authorName.slice(0, 1).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
    {/key}
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2">
        <span class="text-text-bright font-semibold" data-testid="message-author">{authorName}</span>
        <span class="text-text-muted text-xs">{time}</span>
      </div>
      {@render body()}
    </div>
    {#if !editing}
      <MessageActions
        {canEdit}
        {canDelete}
        onReply={() => onReply(message)}
        onEdit={startEdit}
        onDelete={() => onDelete(message)}
        onReact={(e) => handleToggle(e, false)}
      />
    {/if}
  </div>
{/if}
