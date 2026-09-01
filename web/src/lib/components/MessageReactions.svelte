<!--
  MessageReactions — emoji pills under each message.

  Two interactions live here:

  1. The pill (emoji + count) opens a popover listing everyone who
     reacted with that emoji. The full list is fetched lazily via
     `GET /messages/{id}/reactions` so the standard message payload
     stays aggregated (`{emoji, count, me}`); user display info is
     resolved via the shared `userCache` (batched + tombstoned).

  2. The trailing "+" button opens the emoji picker to add a new
     reaction (unchanged).

  Toggling your own reaction used to live on the pill itself, but
  moving it inside the popover (as a top-bar action) keeps the click
  target unambiguous and gives the user a way to see *who* reacted
  before deciding to add/remove. Click-outside / Esc dismisses the
  popover; the chat stays focused.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import SmilePlusIcon from '@lucide/svelte/icons/smile-plus';
  import XIcon from '@lucide/svelte/icons/x';
  import EmojiPicker from './EmojiPicker.svelte';
  import { chatApi } from '$lib/api/chat';
  import type { ReactionAggregate, ReactionUserList } from '$lib/api/types';
  import { userCache } from '$lib/stores/users.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { idealTextColor, sanitizeProfileColor, sanitizeGradientAngle } from '$lib/utils/nameColor';
  import type { Snippet } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import EmptyState from './feedback/EmptyState.svelte';
  import LoadingState from './feedback/LoadingState.svelte';
  import FieldError from './feedback/FieldError.svelte';

  // Hard cap so a viral message doesn't render a thousand-row popover.
  // Discord uses 25; we err generous because reactions are cheap to
  // resolve client-side once the user cache is warm.
  const POPOVER_LIMIT = 50;

  let {
    messageId,
    reactions,
    onToggle,
    children
  }: {
    /** Required for the "who reacted" popover (regular channel messages,
     *  backed by the persistent `message_reactions` table). Omit for
     *  ephemeral reaction stores (watch-party chat) — the pill then
     *  toggles directly, matching the pre-popover behaviour. */
    messageId?: string;
    reactions: ReactionAggregate[];
    onToggle: (emoji: string, currentlyMine: boolean) => void;
    children?: Snippet;
  } = $props();

  let pickerOpen = $state(false);
  // Per-emoji popover open state — key'd by emoji so only one popover
  // is in "loading" mode at a time.
  let openEmoji = $state<string | null>(null);
  let loadingEmoji = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  // Map<emoji, ReactionUserList> — cached so re-opening a pill is
  // instant. Cleared on close so the next toggle-by-someone-else
  // refetches.
  let userLists = $state<Record<string, ReactionUserList | undefined>>({});

  // Watch-party chat has no per-emoji user-list endpoint, so it
  // skips the popover and toggles directly on the pill.
  const supportsPopover = $derived(!!messageId);

  function pick(emoji: string) {
    onToggle(emoji, false);
    pickerOpen = false;
  }

  async function loadReactions(emoji: string): Promise<void> {
    if (userLists[emoji] || !messageId) return;
    loadingEmoji = emoji;
    loadError = null;
    try {
      const route = activeServer.current
        ? { serverId: activeServer.current.id }
        : {};
      const list = await chatApi.listMessageReactions(messageId, route);
      // Index by emoji so the open popover can look up its slice in O(1).
      const indexed: Record<string, ReactionUserList> = {};
      for (const entry of list) indexed[entry.emoji] = entry;
      userLists = { ...userLists, ...indexed };
      // Queue all user ids for batched resolution via the shared
      // userCache. Names will appear as the responses land; the popover
      // shows a fallback initial until then.
      for (const entry of list) for (const id of entry.user_ids) userCache.queue(id);
    } catch (e) {
      loadError = errText(e);
    } finally {
      loadingEmoji = null;
    }
  }

  function handlePopoverOpenChange(emoji: string, open: boolean) {
    if (open) {
      openEmoji = emoji;
      void loadReactions(emoji);
    } else if (openEmoji === emoji) {
      openEmoji = null;
    }
  }

  function handleToggleFromPopover(emoji: string, mine: boolean) {
    onToggle(emoji, mine);
    // Drop the cached slice so the next open reflects the new state.
    // The WS reaction_add/remove event re-syncs the aggregate anyway.
    const { [emoji]: _drop, ...rest } = userLists;
    userLists = rest;
    openEmoji = null;
  }

  // ---- per-user row helpers ------------------------------------------------

  function initialFor(userId: string): string {
    const u = userCache.get(userId);
    const name = u?.display_name ?? u?.username;
    return (name?.[0] ?? '?').toUpperCase();
  }

  function displayNameFor(userId: string): string {
    const u = userCache.get(userId);
    return u?.display_name ?? u?.username ?? '…';
  }

  function avatarStyle(userId: string): string {
    const u = userCache.get(userId);
    const c = sanitizeProfileColor(u?.profile_color);
    return c ? `background: ${c}; color: ${idealTextColor(c)}` : '';
  }

  function nameStyleFor(userId: string): string {
    const u = userCache.get(userId);
    const c1 = sanitizeProfileColor(u?.profile_color);
    const c2 = sanitizeProfileColor(u?.profile_color_secondary);
    if (c1 && c2) {
      const angle = sanitizeGradientAngle(u?.profile_gradient_angle);
      return (
        `background-image: linear-gradient(${angle}deg, ${c1}, ${c2}); ` +
        `-webkit-background-clip: text; background-clip: text; ` +
        `color: transparent; -webkit-text-fill-color: transparent;`
      );
    }
    if (c1) return `color: ${c1}`;
    return '';
  }
</script>

{#if reactions.length > 0}
  <div class="mt-1 flex flex-wrap items-center gap-1" data-testid="message-reactions">
    {#each reactions as r (r.emoji)}
      {@const isOpen = openEmoji === r.emoji}
      {@const list = userLists[r.emoji]}
      {@const visibleUsers = list ? list.user_ids.slice(0, POPOVER_LIMIT) : []}
      {@const hiddenCount = list ? Math.max(0, list.user_ids.length - POPOVER_LIMIT) : 0}
      {#if supportsPopover}
        <PopoverPrimitive.Root open={isOpen} onOpenChange={(o) => handlePopoverOpenChange(r.emoji, o)}>
        <PopoverPrimitive.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors
                     {r.me ? 'border-primary bg-[var(--accent-soft)] text-primary' : 'border-border bg-bg-input text-text-muted hover:bg-bg-hover'}"
              data-testid="reaction-pill"
              data-emoji={r.emoji}
              data-mine={r.me}
              aria-label={m.message_reactions_react()}
            >
              <span class="text-base leading-none">{r.emoji}</span>
              <span class="font-mono">{r.count}</span>
            </button>
          {/snippet}
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          class="bg-popover text-popover-foreground w-72 rounded-2xl border border-border p-3 shadow-xl backdrop-blur-xl"
          data-testid="reaction-popover"
          data-emoji={r.emoji}
        >
          <!-- Header: emoji + count + (un)react button. Sits at the top
               so keyboard users can land on it before tabbing into the
               user list. -->
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="text-xl leading-none">{r.emoji}</span>
              <span class="text-text-muted text-xs font-mono">{r.count}</span>
            </div>
            {#if r.me}
              <Button
                variant="outline"
                size="xs"
                data-testid="reaction-popover-unreact"
                onclick={() => handleToggleFromPopover(r.emoji, true)}
              >
                <XIcon class="size-3" />
                {m.message_reactions_popover_unreact()}
              </Button>
            {:else}
              <Button
                size="xs"
                data-testid="reaction-popover-react"
                onclick={() => handleToggleFromPopover(r.emoji, false)}
              >
                {m.message_reactions_popover_react_with({ emoji: r.emoji })}
              </Button>
            {/if}
          </div>

          {#if loadError}
            <FieldError
              message={m.message_reactions_popover_load_error()}
              class="px-1 py-2"
              testId="reaction-popover-error"
            />
          {:else if loadingEmoji === r.emoji && !list}
            <LoadingState label={m.admin_permissions_loading()} />
          {:else if list && list.user_ids.length === 0}
            <EmptyState message={m.message_reactions_popover_empty()} />
          {:else if list}
            <ul class="flex max-h-64 flex-col gap-0.5 overflow-y-auto" data-testid="reaction-popover-list">
              {#each visibleUsers as uid (uid)}
                {@const me = uid === currentServerUserId()}
                <li
                  class="hover:bg-bg-hover flex items-center gap-2 rounded-md px-2 py-1.5"
                  data-testid="reaction-popover-user"
                  data-user-id={uid}
                >
                  <Avatar.Root class="size-7 shrink-0">
                    {#if userCache.get(uid)?.avatar_url}
                      <Avatar.Image src={userCache.get(uid)?.avatar_url ?? undefined} alt={displayNameFor(uid)} />
                    {/if}
                    <Avatar.Fallback
                      class="text-2xs font-semibold"
                      style={avatarStyle(uid)}
                    >
                      {initialFor(uid)}
                    </Avatar.Fallback>
                  </Avatar.Root>
                  <span
                    class="truncate text-sm"
                    style={nameStyleFor(uid)}
                  >{displayNameFor(uid)}</span>
                  {#if me}
                    <span class="text-text-muted ml-auto text-2xs uppercase tracking-wide">
                      {m.message_reactions_popover_you()}
                    </span>
                  {/if}
                </li>
              {/each}
              {#if hiddenCount > 0}
                <li
                  class="text-text-muted px-2 pt-1 pb-0.5 text-xs"
                  data-testid="reaction-popover-more"
                >
                  {m.message_reactions_popover_more({ count: hiddenCount })}
                </li>
              {/if}
            </ul>
          {/if}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Root>
      {:else}
        <button
          type="button"
          class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors
                 {r.me ? 'border-primary bg-[var(--accent-soft)] text-primary' : 'border-border bg-bg-input text-text-muted hover:bg-bg-hover'}"
          data-testid="reaction-pill"
          data-emoji={r.emoji}
          data-mine={r.me}
          title={r.me ? m.message_reactions_remove_reaction() : m.message_reactions_react()}
          onclick={() => onToggle(r.emoji, r.me)}
        >
          <span class="text-base leading-none">{r.emoji}</span>
          <span class="font-mono">{r.count}</span>
        </button>
      {/if}
    {/each}
    <DropdownMenu.Root bind:open={pickerOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="text-text-muted hover:bg-bg-hover rounded-full border border-border bg-bg-input px-2 py-0.5"
            title={m.message_reactions_add_reaction()}
            aria-label={m.message_reactions_add_reaction()}
            data-testid="reaction-add"
          >
            <SmilePlusIcon class="size-3.5" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="top"
        align="start"
        sideOffset={6}
        class="w-auto max-w-[calc(100vw-1rem)] overflow-visible border-0 bg-transparent p-0 shadow-none"
      >
        <EmojiPicker onPick={pick} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#if children}{@render children()}{/if}
  </div>
{/if}
