<script lang="ts">
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

<div class="group flex gap-3 px-4 py-1 hover:bg-black/10" data-testid="message-item" data-message-id={message.id}>
  <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-sm font-semibold text-white">
    {authorName.slice(0, 1).toUpperCase()}
  </div>
  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-2">
      <span class="font-medium text-[var(--color-text-bright)]" data-testid="message-author">{authorName}</span>
      <span class="text-xs text-[var(--color-text-muted)]">{time}</span>
    </div>
    <div class="break-words text-[var(--color-text-base)]" data-testid="message-content">{message.content}</div>
  </div>
</div>
