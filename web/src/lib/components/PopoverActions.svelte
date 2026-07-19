<!--
  Action buttons rendered inside UserProfilePopover. Owns the permission
  derivations + two-step-confirm state; async handlers live in
  ``popoverActions.ts`` to keep this file under the §12.1 size cap.
-->
<script lang="ts">
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import MicIcon from '@lucide/svelte/icons/mic';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
  import ArrowRightLeftIcon from '@lucide/svelte/icons/arrow-right-left';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import BanIcon from '@lucide/svelte/icons/ban';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import * as actions from './popoverActions';
  import { m } from '$lib/paraglide/messages.js';

  const CHANNEL_TYPE_VOICE = 1;
  const BTN_BASE =
    'hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50';
  const BTN_DANGER =
    'hover:bg-destructive/10 hover:text-destructive text-text-base flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 data-[armed=true]:bg-destructive/10 data-[armed=true]:text-destructive';

  // ``popoverOpen`` mirrors the parent popover's ``open`` for confirm-
  // state reset. ``onOpenNickDialog`` is a callback because the dialog
  // is mounted by the parent (survives the popover unmount).
  let {
    userId,
    displayName,
    guildId,
    isSelf,
    canEditNickname,
    popoverOpen,
    onAction,
    onClose,
    onOpenNickDialog
  }: {
    userId: string;
    displayName: string;
    guildId: string | undefined;
    isSelf: boolean;
    canEditNickname: boolean;
    popoverOpen: boolean;
    onAction?: () => void;
    onClose: () => void;
    onOpenNickDialog: () => void;
  } = $props();

  let working = $state(false);
  let kickConfirmArmed = $state(false);
  let banConfirmArmed = $state(false);
  let moveExpanded = $state(false);

  // Reset the armed-confirm when the popover closes so the next open
  // starts on the safe "Aus Community entfernen" / "Sperren" label.
  $effect(() => {
    if (!popoverOpen) {
      kickConfirmArmed = false;
      banConfirmArmed = false;
      moveExpanded = false;
    }
  });

  // Single source of truth for the guild-owner lookup used by canKick + canBan.
  let guildOwnerId = $derived(
    (guilds.byId[guildId!] ?? serverGuilds.findGuild(guildId!))?.owner_id
  );
  let canKick = $derived.by(() => {
    if (!guildId || isSelf) return false;
    // Can't kick the guild owner even with KICK_MEMBERS.
    if (guildOwnerId && guildOwnerId === userId) return false;
    return roles.hasGuildPermission(guildId, Perm.KICK_MEMBERS);
  });
  let canBan = $derived.by(() => {
    if (!guildId || isSelf) return false;
    if (guildOwnerId && guildOwnerId === userId) return false;
    return roles.hasGuildPermission(guildId, Perm.BAN_MEMBERS);
  });

  // Voice channel (if any) that the target user is currently in within
  // this guild. Force-mute targets a specific channel — the same user
  // could in theory be in multiple guilds' voice channels at once, but
  // within one guild only one (LiveKit identity = user-<id>, room =
  // channel-<id>, so collisions are impossible).
  let targetVoiceChannelId = $derived.by<string | null>(() => {
    if (!guildId || isSelf) return null;
    const channels = guilds.channelsByGuild[guildId] ?? [];
    for (const c of channels) {
      if (c.type !== CHANNEL_TYPE_VOICE) continue;
      if (voicePresence.usersIn(c.id).includes(userId)) return c.id;
    }
    return null;
  });
  // Shared pre-condition for the per-voice-channel admin actions
  // (mute/deafen/disconnect) — the target must currently be in voice.
  let canVoiceAction = $derived(!!guildId && !isSelf && !!targetVoiceChannelId);
  let canMute = $derived(
    canVoiceAction && roles.hasGuildPermission(guildId!, Perm.MUTE_MEMBERS)
  );
  let canDeafen = $derived(
    canVoiceAction && roles.hasGuildPermission(guildId!, Perm.DEAFEN_MEMBERS)
  );
  let canDisconnectVoice = $derived(
    canVoiceAction && roles.hasGuildPermission(guildId!, Perm.MOVE_MEMBERS)
  );
  // "bring into →" submenu: bring the target into a voice channel — a
  // switch if they're connected, a summon otherwise. Gated by MOVE_MEMBERS.
  // Restricted channels the local user can't see aren't in their
  // channelsByGuild, so they're naturally excluded; the backend grants the
  // target temporary VIEW|CONNECT when they lack it.
  let canMoveVoice = $derived(
    !!guildId && !isSelf && roles.hasGuildPermission(guildId!, Perm.MOVE_MEMBERS)
  );
  let moveTargets = $derived.by(() => {
    if (!canMoveVoice || !guildId) return [];
    return (guilds.channelsByGuild[guildId] ?? []).filter(
      (c) => c.type === CHANNEL_TYPE_VOICE && c.id !== targetVoiceChannelId
    );
  });
  let isForceMuted = $derived(
    !!targetVoiceChannelId && voicePresence.isForceMuted(targetVoiceChannelId, userId)
  );
  let isForceDeafened = $derived(
    !!targetVoiceChannelId && voicePresence.isForceDeafened(targetVoiceChannelId, userId)
  );

  // Bound context for the async handlers in ``popoverActions.ts``.
  function ctx(): actions.ActionCtx {
    return {
      userId,
      displayName,
      guildId,
      isSelf,
      targetVoiceChannelId,
      isForceMuted,
      isForceDeafened,
      canMute,
      canDeafen,
      canDisconnectVoice,
      canMoveVoice,
      canBan,
      isWorking: () => working,
      setWorking: (v) => (working = v),
      close: onClose,
      onAction
    };
  }
</script>

{#if !isSelf || canEditNickname}
  <div class="mt-4 flex flex-col gap-1">
    {#if !isSelf}
      <button
        type="button"
        class={BTN_BASE}
        onclick={() => actions.startDM(ctx())}
        disabled={working}
        data-testid="popover-dm-btn"
      >
        <MessageCircleIcon class="size-4" />
        <span>{working ? m.popover_actions_opening() : m.popover_actions_send_message()}</span>
      </button>
    {/if}
    {#if canEditNickname}
      <button
        type="button"
        class={BTN_BASE}
        onclick={onOpenNickDialog}
        data-testid="popover-nickname-btn"
      >
        <PencilIcon class="size-4" />
        <span>{m.popover_actions_edit_nickname()}</span>
      </button>
    {/if}
    {#if canMute}
      <button
        type="button"
        class={BTN_BASE}
        onclick={() => actions.toggleMute(ctx())}
        disabled={working}
        data-testid="popover-mute-btn"
      >
        {#if isForceMuted}
          <MicIcon class="size-4" />
          <span>{m.popover_actions_unmute()}</span>
        {:else}
          <MicOffIcon class="size-4" />
          <span>{m.popover_actions_mute()}</span>
        {/if}
      </button>
    {/if}
    {#if canDeafen}
      <button
        type="button"
        class={BTN_BASE}
        onclick={() => actions.toggleDeafen(ctx())}
        disabled={working}
        title="Force-deafen is UI-only — the user can still hear on modified clients. Use Disconnect to fully remove them."
        data-testid="popover-deafen-btn"
      >
        {#if isForceDeafened}
          <HeadphonesIcon class="size-4" />
          <span>{m.popover_actions_undeafen()}</span>
        {:else}
          <HeadphoneOffIcon class="size-4" />
          <span>{m.popover_actions_deafen()}</span>
        {/if}
      </button>
    {/if}
    {#if canDisconnectVoice}
      <button
        type="button"
        class={BTN_BASE}
        onclick={() => actions.disconnectVoice(ctx())}
        disabled={working}
        data-testid="popover-voice-disconnect-btn"
      >
        <PhoneOffIcon class="size-4" />
        <span>{m.popover_actions_disconnect_voice()}</span>
      </button>
    {/if}
    {#if canMoveVoice && moveTargets.length > 0}
      <button
        type="button"
        class={BTN_BASE}
        onclick={() => (moveExpanded = !moveExpanded)}
        disabled={working}
        aria-expanded={moveExpanded}
        data-testid="popover-voice-move-btn"
      >
        <ArrowRightLeftIcon class="size-4" />
        <span>{m.popover_actions_move_voice()}</span>
      </button>
      {#if moveExpanded}
        <div class="ml-3 flex flex-col gap-1 border-l border-border pl-2">
          {#each moveTargets as ch (ch.id)}
            <button
              type="button"
              class={BTN_BASE}
              onclick={() => actions.moveIntoVoice(ctx(), ch.id)}
              disabled={working}
              data-testid="popover-voice-move-target"
            >
              <Volume2Icon class="size-4 shrink-0" />
              <span class="truncate">{ch.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
    {#if canKick}
      <button
        type="button"
        class={BTN_DANGER}
        data-armed={kickConfirmArmed}
        onclick={() => (kickConfirmArmed ? actions.kick(ctx()) : (kickConfirmArmed = true))}
        disabled={working}
        data-testid="popover-kick-btn"
      >
        <UserMinusIcon class="size-4" />
        <span>
          {#if kickConfirmArmed}
            {m.popover_actions_kick_confirm()}
          {:else}
            {m.popover_actions_kick()}
          {/if}
        </span>
      </button>
    {/if}
    {#if canBan}
      <button
        type="button"
        class={BTN_DANGER}
        data-armed={banConfirmArmed}
        onclick={() => (banConfirmArmed ? actions.ban(ctx()) : (banConfirmArmed = true))}
        disabled={working}
        data-testid="popover-ban-btn"
      >
        <BanIcon class="size-4" />
        <span>
          {#if banConfirmArmed}
            {m.popover_actions_ban_confirm()}
          {:else}
            {m.popover_actions_ban()}
          {/if}
        </span>
      </button>
    {/if}
  </div>
{/if}
