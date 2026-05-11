<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Message } from '$lib/api/types';

  let { message, authorName }: { message: Message; authorName: string } = $props();

  const time = $derived(formatTime(message.created_at));

  function formatTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
</script>

<div
  class="group flex gap-3 px-4 py-1 hover:bg-black/10"
  data-testid="message-item"
  data-message-id={message.id}
>
  <Avatar.Root class="size-10 shrink-0">
    <Avatar.Fallback class="bg-primary text-primary-foreground text-sm font-semibold">
      {authorName.slice(0, 1).toUpperCase()}
    </Avatar.Fallback>
  </Avatar.Root>
  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-2">
      <span class="text-text-bright font-medium" data-testid="message-author">{authorName}</span>
      <span class="text-text-muted text-xs">{time}</span>
    </div>
    <div class="text-text-base break-words" data-testid="message-content">{message.content}</div>
  </div>
</div>
