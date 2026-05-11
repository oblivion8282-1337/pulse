<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Message } from '$lib/api/types';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';

  marked.use({ breaks: true });

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
    const html = marked.parse(text) as string;
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
    avatarUrl = () => null,
    isContinuation = false
  }: {
    message: Message;
    authorName: string;
    avatarUrl?: (m: Message) => string | null;
    isContinuation?: boolean;
  } = $props();

  const time = $derived(formatTime(message.created_at));
  const url = $derived(avatarUrl(message));
  const html = $derived(renderSafe(message.content));

  function formatTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
</script>

{#if isContinuation}
  <div
    class="group flex gap-3 px-4 py-0.5 hover:bg-black/10"
    data-testid="message-item"
    data-message-id={message.id}
  >
    <div class="flex w-10 shrink-0 items-center justify-end">
      <span class="text-text-muted hidden text-[10px] group-hover:block">{time}</span>
    </div>
    <div class="min-w-0 flex-1">
      <div class="text-text-base prose-chat break-words text-sm" data-testid="message-content">
        {@html html}
      </div>
    </div>
  </div>
{:else}
  <div
    class="group flex gap-3 px-4 py-1 hover:bg-black/10"
    data-testid="message-item"
    data-message-id={message.id}
  >
    {#key url}
      <Avatar.Root class="size-10 shrink-0">
        {#if url}
          <Avatar.Image src={url} alt={authorName} />
        {/if}
        <Avatar.Fallback class="bg-primary text-primary-foreground text-sm font-semibold">
          {authorName.slice(0, 1).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
    {/key}
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2">
        <span class="text-text-bright font-medium" data-testid="message-author">{authorName}</span>
        <span class="text-text-muted text-xs">{time}</span>
      </div>
      <div class="text-text-base prose-chat break-words text-sm" data-testid="message-content">
        {@html html}
      </div>
    </div>
  </div>
{/if}
