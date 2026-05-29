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
  import BanIcon from '@lucide/svelte/icons/ban';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import * as actions from './popoverActions';

  const CHANNEL_TYPE_VOICE = 1;

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

  // Reset the armed-confirm when the popover closes so the next open
  // starts on the safe "Aus Community entfernen" / "Sperren" label.
  $effect(() => {
    if (!popoverOpen) {
      kickConfirmArmed = false;
      banConfirmArmed = false;
    }
  });

  let canKick = $derived.by(() => {
    if (!guildId || isSelf) return false;
    // Can't kick the guild owner even with KICK_MEMBERS.
    const ownerId = guilds.byId[guildId]?.owner_id;
    if (ownerId && ownerId === userId) return false;
    return roles.hasGuildPermission(guildId, Perm.KICK_MEMBERS);
  });
  let canBan = $derived.by(() => {
    if (!guildId || isSelf) return false;
    const ownerId = guilds.byId[guildId]?.owner_id;
    if (ownerId && ownerId === userId) return false;
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
  let canMute = $derived.by(
    () =>
      !!guildId &&
      !isSelf &&
      !!targetVoiceChannelId &&
      roles.hasGuildPermission(guildId, Perm.MUTE_MEMBERS)
  );
  let canDeafen = $derived.by(
    () =>
      !!guildId &&
      !isSelf &&
      !!targetVoiceChannelId &&
      roles.hasGuildPermission(guildId, Perm.DEAFEN_MEMBERS)
  );
  let canDisconnectVoice = $derived.by(
    () =>
      !!guildId &&
      !isSelf &&
      !!targetVoiceChannelId &&
      roles.hasGuildPermission(guildId, Perm.MOVE_MEMBERS)
  );
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
        class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
        onclick={() => actions.startDM(ctx())}
        disabled={working}
        data-testid="popover-dm-btn"
      >
        <MessageCircleIcon class="size-4" />
        <span>{working ? 'Öffne…' : 'Nachricht senden'}</span>
      </button>
    {/if}
    {#if canEditNickname}
      <button
        type="button"
        class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
        onclick={onOpenNickDialog}
        data-testid="popover-nickname-btn"
      >
        <PencilIcon class="size-4" />
        <span>Nickname ändern</span>
      </button>
    {/if}
    {#if canMute}
      <button
        type="button"
        class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
        onclick={() => actions.toggleMute(ctx())}
        disabled={working}
        data-testid="popover-mute-btn"
      >
        {#if isForceMuted}
          <MicIcon class="size-4" />
          <span>Stummschaltung aufheben</span>
        {:else}
          <MicOffIcon class="size-4" />
          <span>Stummschalten</span>
        {/if}
      </button>
    {/if}
    {#if canDeafen}
      <button
        type="button"
        class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
        onclick={() => actions.toggleDeafen(ctx())}
        disabled={working}
        data-testid="popover-deafen-btn"
      >
        {#if isForceDeafened}
          <HeadphonesIcon class="size-4" />
          <span>Taubschaltung aufheben</span>
        {:else}
          <HeadphoneOffIcon class="size-4" />
          <span>Taubschalten</span>
        {/if}
      </button>
    {/if}
    {#if canDisconnectVoice}
      <button
        type="button"
        class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
        onclick={() => actions.disconnectVoice(ctx())}
        disabled={working}
        data-testid="popover-voice-disconnect-btn"
      >
        <PhoneOffIcon class="size-4" />
        <span>Aus Voice trennen</span>
      </button>
    {/if}
    {#if canKick}
      <button
        type="button"
        class="hover:bg-red-500/10 hover:text-red-400 text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 data-[armed=true]:bg-red-500/10 data-[armed=true]:text-red-400"
        data-armed={kickConfirmArmed}
        onclick={() => (kickConfirmArmed ? actions.kick(ctx()) : (kickConfirmArmed = true))}
        disabled={working}
        data-testid="popover-kick-btn"
      >
        <UserMinusIcon class="size-4" />
        <span>
          {#if kickConfirmArmed}
            Wirklich entfernen?
          {:else}
            Aus Community entfernen
          {/if}
        </span>
      </button>
    {/if}
    {#if canBan}
      <button
        type="button"
        class="hover:bg-red-500/10 hover:text-red-400 text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 data-[armed=true]:bg-red-500/10 data-[armed=true]:text-red-400"
        data-armed={banConfirmArmed}
        onclick={() => (banConfirmArmed ? actions.ban(ctx()) : (banConfirmArmed = true))}
        disabled={working}
        data-testid="popover-ban-btn"
      >
        <BanIcon class="size-4" />
        <span>
          {#if banConfirmArmed}
            Wirklich sperren?
          {:else}
            Sperren
          {/if}
        </span>
      </button>
    {/if}
  </div>
{/if}
