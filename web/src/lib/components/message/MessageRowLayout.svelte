<script lang="ts">
  /**
   * Die klassische Zeilen-Hülle einer Nachricht: Avatar links, darüber Name
   * und Uhrzeit, Fortsetzungen ohne beides.
   *
   * Aus `MessageItem.svelte` herausgelöst, als die privaten Nachrichten eine
   * zweite Hülle bekamen (Sprechblasen, Mobil-Umbau 2026-08-22). **Nur die
   * Hülle wandert** — Inhalt, Bearbeiten, Anhänge, Reaktionen, Melden und das
   * Aktionsblatt bleiben in `MessageItem` und werden als Schnipsel
   * hereingereicht. Eine eigene Sprechblasen-Komponente hätte all das
   * stillschweigend verloren.
   *
   * Markup unverändert übernommen, `data-testid` identisch.
   */
  import type { Snippet } from 'svelte';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { longpress } from '$lib/utils/longpress';
  import type { Message } from '$lib/api/types';

  let {
    message,
    authorName,
    authorStyle = '',
    url,
    time,
    isContinuation = false,
    highlight = false,
    onLongPress,
    body,
    actions
  }: {
    message: Message;
    authorName: string;
    authorStyle?: string;
    url: string | null;
    time: string;
    isContinuation?: boolean;
    highlight?: boolean;
    onLongPress: () => void;
    body: Snippet;
    actions: Snippet;
  } = $props();
</script>

{#if isContinuation}
  <div
    class="group relative mx-2 flex gap-3 rounded-2xl px-3 py-0.5 transition-colors hover:bg-bg-hover"
    class:ring-2={highlight}
    class:ring-primary={highlight}
    data-testid="message-item"
    data-message-id={message.id}
    use:longpress={{ onLongPress }}
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
    use:longpress={{ onLongPress }}
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
