<!--
  Click-to-open user profile card.

  Wraps any trigger element and pops a floating card with the user's
  avatar, display name, and quick actions (currently: "Nachricht senden").
  Designed as the canonical place for per-user actions — additional
  buttons (mention, view profile, give role…) land here later without
  touching the call sites.

  Self-detection: the action list is hidden when the user clicks their
  own row, so the popover gracefully degrades to a read-only profile
  card instead of letting them DM themselves (the server rejects that
  with a 400 anyway).
-->
<script lang="ts">
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import { toast } from 'svelte-sonner';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { chatApi } from '$lib/api/chat';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';
  import type { Snippet } from 'svelte';

  let {
    userId,
    displayName,
    avatarUrl,
    onAction,
    extra,
    children
  }: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    /** Fired after an action navigates away — used by the caller to close
     *  parent overlays (e.g. the mobile member-list sheet). */
    onAction?: () => void;
    /** Optional caller-supplied extra content rendered below the standard
     *  actions. Receives a `close` callback so it can dismiss the popover
     *  after a destructive/navigation action. Used e.g. for the per-user
     *  voice volume slider in voice-channel members. */
    extra?: Snippet<[{ close: () => void }]>;
    /** Trigger snippet; bits-ui passes `props` to spread onto the element. */
    children: Snippet<[{ props: Record<string, unknown> }]>;
  } = $props();

  function close() {
    open = false;
  }

  let open = $state(false);
  let working = $state(false);

  let isSelf = $derived(!!auth.user && userId === auth.user.id);

  async function startDM() {
    if (isSelf || working) return;
    working = true;
    try {
      const dm = await chatApi.createOrGetDMChannel(userId);
      directMessages.upsert(dm);
      open = false;
      onAction?.();
      await goto(`/app/@me/${dm.id}`);
    } catch (err) {
      toast.error('DM konnte nicht geöffnet werden', {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      working = false;
    }
  }

  function initials(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }
</script>

<PopoverPrimitive.Root bind:open>
  <PopoverPrimitive.Trigger>
    {#snippet child({ props })}
      {@render children({ props })}
    {/snippet}
  </PopoverPrimitive.Trigger>
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      sideOffset={8}
      side="left"
      align="start"
      class="ring-border bg-popover text-popover-foreground z-50 w-64 rounded-xl p-4 shadow-xl ring-1 outline-none backdrop-blur-xl data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 data-open:zoom-in-95 data-closed:zoom-out-95"
      data-testid="user-profile-popover"
    >
      <div class="flex items-center gap-3">
        <Avatar.Root class="size-12 shrink-0">
          {#if avatarUrl}
            <Avatar.Image src={avatarUrl} alt={displayName} />
          {/if}
          <Avatar.Fallback class="accent-gradient text-primary-foreground text-base font-semibold">
            {initials(displayName)}
          </Avatar.Fallback>
        </Avatar.Root>
        <div class="min-w-0 flex-1">
          <p class="text-text-bright truncate text-base font-semibold">{displayName}</p>
          {#if isSelf}
            <p class="text-text-muted text-xs">Das bist du</p>
          {/if}
        </div>
      </div>

      {#if !isSelf}
        <div class="mt-4 flex flex-col gap-1">
          <button
            type="button"
            class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
            onclick={startDM}
            disabled={working}
            data-testid="popover-dm-btn"
          >
            <MessageCircleIcon class="size-4" />
            <span>{working ? 'Öffne…' : 'Nachricht senden'}</span>
          </button>
        </div>
      {/if}

      {#if extra}
        <div class="mt-3">
          {@render extra({ close })}
        </div>
      {/if}
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
</PopoverPrimitive.Root>
