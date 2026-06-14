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

  This file is intentionally a thin layout shell — the action buttons
  and their handlers live in `PopoverActions.svelte`, the nickname
  dialog stays mounted here so it survives the popover closing.
-->
<script lang="ts">
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import NicknameDialog from './NicknameDialog.svelte';
  import ReportMessageDialog from './chat/ReportMessageDialog.svelte';
  import PopoverActions from './PopoverActions.svelte';
  import PopoverFriendActions from './PopoverFriendActions.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { roles } from '$lib/stores/roles.svelte';
  import { nameStyle } from '$lib/utils/nameColor';
  import { Perm } from '$lib/permissions/bitfield';
  import type { Snippet } from 'svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    userId,
    displayName,
    avatarUrl,
    guildId,
    nickname,
    onAction,
    extra,
    children
  }: {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    /** Guild scope — enables guild-specific actions like nickname editing.
     *  Omitted in non-guild contexts (DM list, voice tiles without a
     *  matching member context). */
    guildId?: string;
    /** Current per-guild nickname for this user; ``null`` if none set,
     *  ``undefined`` if the caller doesn't know (the dialog will then
     *  lazily resolve it on open). Only meaningful when ``guildId`` is
     *  provided. */
    nickname?: string | null | undefined;
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

  let open = $state(false);
  let nickDialogOpen = $state(false);
  let reportDialogOpen = $state(false);

  function close() {
    open = false;
  }

  let isSelf = $derived(userId === currentServerUserId());
  let canEditNickname = $derived.by(() => {
    if (!guildId) return false;
    return isSelf
      ? roles.hasGuildPermission(guildId, Perm.CHANGE_NICKNAME)
      : roles.hasGuildPermission(guildId, Perm.MANAGE_NICKNAMES);
  });

  function initials(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  let displayNameStyle = $derived(nameStyle(userId, guildId ?? null));
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
          <p
            class="text-text-bright truncate text-base font-semibold"
            style={displayNameStyle}
          >{displayName}</p>
          {#if isSelf}
            <p class="text-text-muted text-xs">{m.user_profile_popover_this_is_you()}</p>
          {/if}
        </div>
      </div>

      <PopoverActions
        {userId}
        {displayName}
        {guildId}
        {isSelf}
        {canEditNickname}
        popoverOpen={open}
        {onAction}
        onClose={close}
        onOpenNickDialog={() => (nickDialogOpen = true)}
      />

      {#if !isSelf}
        <PopoverFriendActions
          {userId}
          {displayName}
          popoverOpen={open}
          onClose={close}
          {onAction}
        />
        <button
          type="button"
          class="text-text-muted hover:text-text-bright hover:bg-bg-hover mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors"
          onclick={() => {
            reportDialogOpen = true;
            close();
          }}
          data-testid="user-profile-report-btn"
        >
          <FlagIcon class="size-3.5" />
          {m.user_profile_report()}
        </button>
      {/if}

      {#if extra}
        <div class="mt-3">
          {@render extra({ close })}
        </div>
      {/if}
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
</PopoverPrimitive.Root>

{#if reportDialogOpen}
  <ReportMessageDialog
    kind="user"
    {userId}
    open={true}
    onClose={() => (reportDialogOpen = false)}
  />
{/if}

{#if canEditNickname && guildId}
  <NicknameDialog
    open={nickDialogOpen}
    {guildId}
    {userId}
    {isSelf}
    initialNickname={nickname}
    fallbackName={displayName}
    onClose={() => {
      nickDialogOpen = false;
      close();
    }}
  />
{/if}
