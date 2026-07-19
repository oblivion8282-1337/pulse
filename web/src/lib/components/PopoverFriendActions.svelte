<!--
  Friend-related actions rendered inside UserProfilePopover.

  State-matrix:
    blocked        → Entblockieren
    isFriend       → Freund entfernen + Blockieren
    pendingOut      → Anfrage zurückziehen + Blockieren
    pendingIn       → Annehmen + Ablehnen + Blockieren
    none           → Freundschaftsanfrage senden + Blockieren

  Self-detection is done by the parent — this component is never rendered
  for isSelf===true.
-->
<script lang="ts">
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import UserCheckIcon from '@lucide/svelte/icons/user-check';
  import XIcon from '@lucide/svelte/icons/x';
  import CheckIcon from '@lucide/svelte/icons/check';
  import BanIcon from '@lucide/svelte/icons/ban';
  import MailPlusIcon from '@lucide/svelte/icons/mail-plus';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import { friends } from '$lib/stores/friends.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import { blocks } from '$lib/stores/blocks.svelte';
  import * as actions from './popoverActions';
  import InviteToServerSubmenu from './InviteToServerSubmenu.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    userId,
    displayName,
    popoverOpen,
    onClose,
    onAction
  }: {
    userId: string;
    displayName: string;
    popoverOpen: boolean;
    onClose: () => void;
    onAction?: () => void;
  } = $props();

  let working = $state(false);
  let inviteSubmenuOpen = $state(false);

  // Reset on close.
  $effect(() => {
    if (!popoverOpen) {
      working = false;
      inviteSubmenuOpen = false;
    }
  });

  let isBlocked = $derived(blocks.has(userId));
  let isFriend = $derived(friends.has(userId));

  // Lookup pending requests by userId.
  let pendingOut = $derived(
    friendRequests.outgoingList.find((r) => r.receiver_id === userId) ?? null
  );
  let pendingIn = $derived(
    friendRequests.incomingList.find((r) => r.sender_id === userId) ?? null
  );

  function ctx(): actions.ActionCtx {
    return {
      userId,
      displayName,
      guildId: undefined,
      isSelf: false,
      targetVoiceChannelId: null,
      isForceMuted: false,
      isForceDeafened: false,
      canMute: false,
      canDeafen: false,
      canDisconnectVoice: false,
      canMoveVoice: false,
      canBan: false,
      isWorking: () => working,
      setWorking: (v) => (working = v),
      close: onClose,
      onAction
    };
  }

  const btnBase =
    'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50';
  const btnNormal = `${btnBase} hover:bg-bg-hover hover:text-primary text-text-base`;
  const btnDanger = `${btnBase} hover:bg-destructive/10 hover:text-destructive text-text-base`;
</script>

<div class="mt-1 flex flex-col gap-1 border-t border-border pt-3">
  {#if isBlocked}
    <button
      type="button"
      class={btnNormal}
      onclick={() => actions.unblockUser(ctx())}
      disabled={working}
      data-testid="popover-unblock-btn"
    >
      <BanIcon class="size-4" />
      <span>{m.popover_friend_actions_unblock()}</span>
    </button>
  {:else if isFriend}
    <button
      type="button"
      class={btnNormal}
      onclick={() => (inviteSubmenuOpen = !inviteSubmenuOpen)}
      disabled={working}
      data-testid="popover-invite-to-server-btn"
    >
      <MailPlusIcon class="size-4" />
      <span class="flex-1">{m.popover_friend_actions_invite_to_community()}</span>
      <ChevronDownIcon class="size-3 transition-transform {inviteSubmenuOpen ? 'rotate-180' : ''}" />
    </button>
    {#if inviteSubmenuOpen}
      <InviteToServerSubmenu
        friendUserId={userId}
        friendName={displayName}
        onDone={() => { inviteSubmenuOpen = false; onClose(); }}
      />
    {/if}
    <button
      type="button"
      class={btnDanger}
      onclick={() => actions.removeFriend(ctx())}
      disabled={working}
      data-testid="popover-remove-friend-btn"
    >
      <UserMinusIcon class="size-4" />
      <span>{m.popover_friend_actions_remove_friend()}</span>
    </button>
    <button
      type="button"
      class={btnDanger}
      onclick={() => actions.blockUser(ctx())}
      disabled={working}
      data-testid="popover-block-btn"
    >
      <BanIcon class="size-4" />
      <span>{m.popover_friend_actions_block()}</span>
    </button>
  {:else if pendingOut}
    <button
      type="button"
      class={btnNormal}
      onclick={() => actions.cancelFriendRequest(ctx(), pendingOut!.id)}
      disabled={working}
      data-testid="popover-cancel-request-btn"
    >
      <XIcon class="size-4" />
      <span>{m.popover_friend_actions_cancel_request()}</span>
    </button>
    <button
      type="button"
      class={btnDanger}
      onclick={() => actions.blockUser(ctx())}
      disabled={working}
      data-testid="popover-block-btn"
    >
      <BanIcon class="size-4" />
      <span>{m.popover_friend_actions_block()}</span>
    </button>
  {:else if pendingIn}
    <button
      type="button"
      class={btnNormal}
      onclick={() => actions.acceptFriendRequest(ctx(), pendingIn!.id)}
      disabled={working}
      data-testid="popover-accept-request-btn"
    >
      <CheckIcon class="size-4" />
      <span>{m.popover_friend_actions_accept_request()}</span>
    </button>
    <button
      type="button"
      class={btnNormal}
      onclick={() => actions.declineFriendRequest(ctx(), pendingIn!.id)}
      disabled={working}
      data-testid="popover-decline-request-btn"
    >
      <XIcon class="size-4" />
      <span>{m.popover_friend_actions_decline_request()}</span>
    </button>
    <button
      type="button"
      class={btnDanger}
      onclick={() => actions.blockUser(ctx())}
      disabled={working}
      data-testid="popover-block-btn"
    >
      <BanIcon class="size-4" />
      <span>{m.popover_friend_actions_block()}</span>
    </button>
  {:else}
    <button
      type="button"
      class={btnNormal}
      onclick={() => actions.sendFriendRequest(ctx())}
      disabled={working}
      data-testid="popover-add-friend-btn"
    >
      <UserPlusIcon class="size-4" />
      <span>{m.popover_friend_actions_send_friend_request()}</span>
    </button>
    <button
      type="button"
      class={btnDanger}
      onclick={() => actions.blockUser(ctx())}
      disabled={working}
      data-testid="popover-block-btn"
    >
      <BanIcon class="size-4" />
      <span>{m.popover_friend_actions_block()}</span>
    </button>
  {/if}
</div>
