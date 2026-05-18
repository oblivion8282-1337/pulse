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
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import MicOffIcon from '@lucide/svelte/icons/mic-off';
  import MicIcon from '@lucide/svelte/icons/mic';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOffIcon from '@lucide/svelte/icons/headphone-off';
  import { toast } from 'svelte-sonner';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import NicknameDialog from './NicknameDialog.svelte';
  import { chatApi } from '$lib/api/chat';
  import { setVoiceOverride } from '$lib/api/voice';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { goto } from '$app/navigation';
  import type { Snippet } from 'svelte';

  const CHANNEL_TYPE_VOICE = 1;

  let {
    userId,
    displayName,
    avatarUrl,
    guildId,
    nickname = null,
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
    /** Current per-guild nickname for this user; ``null`` if none set.
     *  Only meaningful when ``guildId`` is provided. */
    nickname?: string | null;
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
  let nickDialogOpen = $state(false);
  let kickConfirmArmed = $state(false);

  // Reset the armed-confirm when the popover closes so the next open
  // starts on the safe "Aus Server entfernen" label.
  $effect(() => {
    if (!open) kickConfirmArmed = false;
  });

  let isSelf = $derived(!!auth.user && userId === auth.user.id);
  let canEditNickname = $derived.by(() => {
    if (!guildId) return false;
    return isSelf
      ? roles.hasGuildPermission(guildId, Perm.CHANGE_NICKNAME)
      : roles.hasGuildPermission(guildId, Perm.MANAGE_NICKNAMES);
  });
  let canKick = $derived.by(() => {
    if (!guildId || isSelf) return false;
    // Can't kick the guild owner even with KICK_MEMBERS.
    const ownerId = guilds.byId[guildId]?.owner_id;
    if (ownerId && ownerId === userId) return false;
    return roles.hasGuildPermission(guildId, Perm.KICK_MEMBERS);
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
  let canMute = $derived.by(() => {
    if (!guildId || isSelf) return false;
    if (!targetVoiceChannelId) return false;
    return roles.hasGuildPermission(guildId, Perm.MUTE_MEMBERS);
  });
  let canDeafen = $derived.by(() => {
    if (!guildId || isSelf) return false;
    if (!targetVoiceChannelId) return false;
    return roles.hasGuildPermission(guildId, Perm.DEAFEN_MEMBERS);
  });
  let isForceMuted = $derived.by(() => {
    if (!targetVoiceChannelId) return false;
    return voicePresence.isForceMuted(targetVoiceChannelId, userId);
  });
  let isForceDeafened = $derived.by(() => {
    if (!targetVoiceChannelId) return false;
    return voicePresence.isForceDeafened(targetVoiceChannelId, userId);
  });

  async function toggleMute() {
    if (!canMute || !targetVoiceChannelId || working) return;
    working = true;
    try {
      const next = !isForceMuted;
      const result = await setVoiceOverride(targetVoiceChannelId, userId, {
        mute: next
      });
      // Optimistic local update — the WS event echo will reconfirm.
      voicePresence.applyOverride(
        targetVoiceChannelId,
        userId,
        result.muted,
        result.deafened
      );
      toast.success(next ? `${displayName} stummgeschaltet` : `Stummschaltung aufgehoben`);
    } catch (err) {
      toast.error('Stummschaltung fehlgeschlagen', {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      working = false;
    }
  }

  async function toggleDeafen() {
    if (!canDeafen || !targetVoiceChannelId || working) return;
    working = true;
    try {
      const next = !isForceDeafened;
      const result = await setVoiceOverride(targetVoiceChannelId, userId, {
        deafen: next
      });
      voicePresence.applyOverride(
        targetVoiceChannelId,
        userId,
        result.muted,
        result.deafened
      );
      toast.success(
        next ? `${displayName} taubgeschaltet` : `Taubschaltung aufgehoben`
      );
    } catch (err) {
      toast.error('Taubschaltung fehlgeschlagen', {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      working = false;
    }
  }

  async function kick() {
    if (!guildId || working) return;
    working = true;
    try {
      await chatApi.kickMember(guildId, userId);
      toast.success(`${displayName} entfernt`);
      open = false;
      kickConfirmArmed = false;
      onAction?.();
    } catch (err) {
      toast.error('Mitglied konnte nicht entfernt werden', {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      working = false;
    }
  }

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

      {#if !isSelf || canEditNickname}
        <div class="mt-4 flex flex-col gap-1">
          {#if !isSelf}
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
          {/if}
          {#if canEditNickname}
            <button
              type="button"
              class="hover:bg-bg-hover hover:text-primary text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50"
              onclick={() => (nickDialogOpen = true)}
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
              onclick={toggleMute}
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
              onclick={toggleDeafen}
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
          {#if canKick}
            <button
              type="button"
              class="hover:bg-red-500/10 hover:text-red-400 text-text-base flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-50 data-[armed=true]:bg-red-500/10 data-[armed=true]:text-red-400"
              data-armed={kickConfirmArmed}
              onclick={() => (kickConfirmArmed ? kick() : (kickConfirmArmed = true))}
              disabled={working}
              data-testid="popover-kick-btn"
            >
              <UserMinusIcon class="size-4" />
              <span>
                {#if kickConfirmArmed}
                  Wirklich entfernen?
                {:else}
                  Aus Server entfernen
                {/if}
              </span>
            </button>
          {/if}
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
