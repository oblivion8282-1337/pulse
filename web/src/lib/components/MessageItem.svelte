<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Message } from '$lib/api/types';
  import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
  import MessageActions from './MessageActions.svelte';
  import MessageActionSheet from './MessageActionSheet.svelte';
  import MessageAttachments from './MessageAttachments.svelte';
  import MessageReactions from './MessageReactions.svelte';
  import InviteEmbed from './InviteEmbed.svelte';
  import LinkEmbed from './LinkEmbed.svelte';
  import ReportMessageDialog from './chat/ReportMessageDialog.svelte';
  import { detectEmbeds } from '$lib/embeds/providers';
  import { renderMessage } from './messageRender';
  import { longpress } from '$lib/utils/longpress';
  import { m } from '$lib/paraglide/messages.js';

  let {
    message,
    authorName,
    authorStyle = '',
    replyTo,
    avatarUrl = () => null,
    isContinuation = false,
    /** Kurzzeitiges Highlight (Ring) — z.B. nach jumpToReply. */
    highlight = false,
    canEdit,
    canDelete,
    /** Ob der aktuelle User Nachrichten anderer melden darf (= nicht eigen). */
    canReport = false,
    /** Direktnachricht-Kontext: eine Meldung geht ans Betreiberteam statt an
     *  einen Community-Moderator (es gibt hier keinen). */
    isDirect = false,
    onReply,
    onEditSubmit,
    onDelete,
    onToggleReaction,
    onJumpToReply
  }: {
    message: Message;
    authorName: string;
    /** Fertiges Inline-`style` für den Namen (Farbe oder Verlauf); '' → Standard. */
    authorStyle?: string;
    replyTo?: { id: string; author: string; snippet: string } | null;
    avatarUrl?: (m: Message) => string | null;
    isContinuation?: boolean;
    highlight?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canReport?: boolean;
    isDirect?: boolean;
    onReply: (m: Message) => void;
    onEditSubmit: (m: Message, newContent: string) => void;
    onDelete: (m: Message) => void;
    onToggleReaction: (m: Message, emoji: string, currentlyMine: boolean) => void;
    onJumpToReply?: (parentId: string) => void;
  } = $props();

  let reportOpen = $state(false);

  let editing = $state(false);
  let draft = $state('');
  // Touch action sheet — opened by long-press, the only message-action path
  // on a device with no hover (the `MessageActions` toolbar is hover-gated).
  let sheetOpen = $state(false);

  const time = $derived(formatTime(message.created_at));
  const url = $derived(avatarUrl(message));
  const html = $derived(renderMessage(message.content, message.mentions));
  const reactions = $derived(message.reactions ?? []);
  const attachments = $derived(message.attachments ?? []);
  const isEdited = $derived(!!message.edited_at);

  // Invite-Embed-Detection: extract the first /invite/<code> from the content.
  // Require an explicit https?:// prefix so bare /invite/XXXXXXXX substrings
  // (e.g. in path segments of unrelated URLs) do not trigger an embed fetch.
  // Capture-Gruppe 1 = Code, 2 = optionaler ``?host=<fqdn>`` (Self-Host-Invite).
  const INVITE_RE = /https?:\/\/[^\s]+\/invite\/([A-Za-z0-9]{8})(?:\?host=([^\s&#]+))?/;
  const inviteMatch = $derived(message.content.match(INVITE_RE));
  const inviteCode = $derived(inviteMatch ? inviteMatch[1] : null);
  const inviteHost = $derived(inviteMatch && inviteMatch[2] ? decodeURIComponent(inviteMatch[2]) : null);
  // Suppress the raw text entirely when the message is *only* the invite link
  // (possibly with surrounding whitespace).
  const isInviteOnly = $derived(
    !!inviteCode && message.content.trim().replace(INVITE_RE, '').trim() === ''
  );
  // Optimistic copy still awaiting its server echo — it has no real id yet,
  // so edit / delete / react would hit `/messages/tmp-…` and 4xx. Gate them
  // until the echo swaps in the persisted message.
  const isPending = $derived(message.id.startsWith('tmp-'));

  // Link-Previews: erkenne unterstützte Provider-URLs (YouTube/Vimeo/Spotify)
  // im Inhalt und rendere darunter je eine Karte. Der Rohlink bleibt im Text
  // klickbar (Discord-Verhalten) — die Karte ist additiv.
  const linkEmbeds = $derived(detectEmbeds(message.content));

  function formatTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function startEdit() {
    if (isPending) return;
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
    if (isPending) return;
    onToggleReaction(message, emoji, mine);
  }

  function openSheet() {
    // Nothing actionable on a still-editing or not-yet-persisted message.
    if (editing || isPending) return;
    sheetOpen = true;
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
      class="text-text-bright w-full rounded-md border border-border bg-bg-input px-2 py-1 text-[15px] outline-none focus:border-primary"
      data-testid="message-edit-input"
    ></textarea>
    <div class="text-text-muted mt-0.5 text-2xs">
      {m.message_item_edit_hint()}
    </div>
  {:else}
    {#if message.content && !isInviteOnly}
      <div class="text-text-base break-words text-[15px]" data-testid="message-content">
        {@html html}
        {#if isEdited}
          <span class="text-text-muted text-2xs" title={message.edited_at ?? ''}>{m.message_item_edited_label()}</span>
        {/if}
      </div>
    {/if}
    {#if inviteCode}
      <InviteEmbed code={inviteCode} host={inviteHost} />
    {/if}
    {#each linkEmbeds as embed (embed.url)}
      <LinkEmbed url={embed.url} provider={embed.provider} />
    {/each}
    <MessageAttachments {attachments} />
    <MessageReactions messageId={message.id} {reactions} onToggle={handleToggle} />
  {/if}
{/snippet}

{#snippet actions()}
  {#if !editing}
    <MessageActions
      canEdit={canEdit && !isPending}
      canDelete={canDelete && !isPending}
      canReport={canReport && !isPending}
      onReply={() => onReply(message)}
      onEdit={startEdit}
      onDelete={() => onDelete(message)}
      onReact={(e) => handleToggle(e, false)}
      onReport={() => (reportOpen = true)}
    />
  {/if}
{/snippet}

{#if isContinuation}
  <div
    class="group relative mx-2 flex gap-3 rounded-2xl px-3 py-0.5 transition-colors hover:bg-bg-hover"
    class:ring-2={highlight}
    class:ring-primary={highlight}
    data-testid="message-item"
    data-message-id={message.id}
    use:longpress={{ onLongPress: openSheet }}
  >
    <div class="flex w-10 shrink-0 items-center justify-end">
      <span class="text-text-muted hidden text-2xs group-hover:block pointer-coarse:block">{time}</span>
    </div>
    <div class="min-w-0 flex-1">
      {@render body()}
    </div>
    {@render actions()}
  </div>
{:else}
  <div
    class="group relative mx-2 flex gap-3 rounded-2xl px-3 py-1.5 transition-colors hover:bg-bg-hover"
    class:ring-2={highlight}
    class:ring-primary={highlight}
    data-testid="message-item"
    data-message-id={message.id}
    use:longpress={{ onLongPress: openSheet }}
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
        <span
          class="text-text-bright font-semibold"
          style={authorStyle}
          data-testid="message-author">{authorName}</span>
        <span class="text-text-muted text-xs">{time}</span>
      </div>
      {@render body()}
    </div>
    {@render actions()}
  </div>
{/if}

<MessageActionSheet
  bind:open={sheetOpen}
  canEdit={canEdit && !isPending}
  canDelete={canDelete && !isPending}
  canReport={canReport && !isPending}
  onReply={() => onReply(message)}
  onEdit={startEdit}
  onDelete={() => onDelete(message)}
  onReact={(e) => handleToggle(e, false)}
  onReport={() => (reportOpen = true)}
/>

<ReportMessageDialog
  messageId={message.id}
  userId={message.author_id}
  toCloud={isDirect}
  bind:open={reportOpen}
  onClose={() => {
    reportOpen = false;
    // Das Touch-Aktions-Sheet bleibt hinter dem Dialog offen (es schließt sich
    // NICHT beim Öffnen — das würde die Dialog-Felder tot machen, bits-ui-
    // Overlay-Race); erst wenn der Melden-Dialog zugeht, räumen wir es weg.
    sheetOpen = false;
  }}
/>

<style>
  /* Mention pills emitted by `renderMessage` — `:global` because the
     `<span class="mention …">` lives inside an `{@html}` block. */
  :global(.mention) {
    background-color: var(--accent-soft);
    color: var(--primary);
    border-radius: 0.375rem;
    padding: 0 0.25rem;
    font-weight: 600;
  }
  :global(.mention--self) {
    background-color: color-mix(in oklab, var(--primary) 25%, transparent);
    color: var(--text-bright, var(--primary-foreground));
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 60%, transparent);
  }
</style>
