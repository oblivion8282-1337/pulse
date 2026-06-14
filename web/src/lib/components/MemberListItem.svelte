<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import MemberQuickRoleMenu from './MemberQuickRoleMenu.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameColor, idealTextColor } from '$lib/utils/nameColor';
  import { roles } from '$lib/stores/roles.svelte';
  import { memberRoles } from '$lib/stores/memberRoles.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { goto } from '$app/navigation';
  import type { Member } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    member,
    guildId,
    isSpeaking,
    isPartyHost,
    isStreaming,
    isOffline,
    canQuickRole,
    onActivityClick,
    onPartyClick,
    onClose
  }: {
    member: Member;
    guildId: string;
    isSpeaking: boolean;
    isPartyHost: boolean;
    isStreaming: boolean;
    isOffline: boolean;
    canQuickRole: boolean;
    /** Click on the LIVE (stream / screen-share) badge. */
    onActivityClick: (uid: string) => void;
    /** Click on the PARTY badge — opens (or lets you pick) the user's party. */
    onPartyClick: (uid: string) => void;
    onClose?: () => void;
  } = $props();

  let name = $derived(member.nickname ?? userCache.displayName(member.user_id));
  let url = $derived(safeAvatarUrl(userCache.get(member.user_id)?.avatar_url));
  let initials = $derived(name.slice(0, 1).toUpperCase());
  let colour = $derived.by<string | null>(() => {
    const ids = memberRoles.for(guildId, member.user_id);
    const top = roles.topColorRole(guildId, ids);
    if (top) return '#' + top.color.toString(16).padStart(6, '0');
    // Keine farbige Rolle → Profilfarbe des Users (Profileinstellungen).
    return nameColor(member.user_id, null);
  });

  /** Spin up (or fetch) a DM channel with the target user and navigate
   * there. Same flow as the UserProfilePopover's "DM" button — mirrored
   * here so the member-list right-click works without left-clicking
   * through the profile popover first. */
  async function openDmWith(targetUserId: string): Promise<void> {
    if (targetUserId === currentServerUserId()) return;
    try {
      const dm = await chatApi.createOrGetDMChannel(targetUserId);
      directMessages.upsert(dm);
      onClose?.();
      await goto(`/app/@me/${dm.id}`);
    } catch (err) {
      toast.error(m.member_list_item_dm_open_failed(), {
        description: err instanceof Error ? err.message : String(err)
      });
    }
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props: ctxProps })}
      <!--
        ContextMenu and Popover both want to be the trigger for the
        same logical row. Spreading both prop bags onto one element
        breaks: bits-ui assigns each trigger its own ``id``/``ref``/
        ``data-state`` and the later spread wins, leaving one of the
        two triggers half-wired. We split them: the outer ``<div>``
        is the ContextMenu trigger (right-click), the inner
        ``<button>`` keeps the popover (left-click) and the
        ``data-testid`` the tests rely on.
      -->
      <div {...ctxProps} class="contents">
        <UserProfilePopover
          userId={member.user_id}
          displayName={name}
          avatarUrl={url}
          {guildId}
          nickname={member.nickname}
          onAction={onClose}
        >
          {#snippet children({ props })}
            <button
              {...props}
              type="button"
              class="hover:bg-bg-hover flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors data-[state=open]:bg-bg-hover {isOffline ? 'opacity-50' : ''}"
              data-testid="member-item"
              data-user-id={member.user_id}
              oncontextmenu={() => {
                // Prime the lazy per-member role cache so the quick-role
                // sub-menu shows the correct checkbox state on first open
                // (replaces MemberQuickRoleMenu's unwired `onOpen` export).
                // No-op when the menu wouldn't render anyway.
                if (canQuickRole) {
                  void memberRoles.ensure(guildId, member.user_id).catch(() => undefined);
                }
              }}
            >
              <span class="relative size-8 shrink-0" data-speaking={isSpeaking}>
                {#if isSpeaking}
                  <!-- Two staggered rings build the sonar "ping" — identical to
                       the voice-channel members list in the left rail. -->
                  <span
                    class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
                    style={colour ? `border-color: ${colour}` : ''}
                    aria-hidden="true"
                    data-testid="member-speaking-ring"
                  ></span>
                  <span
                    class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
                    style={colour ? `border-color: ${colour}` : ''}
                    aria-hidden="true"
                  ></span>
                {/if}
                <Avatar.Root class="relative size-8">
                  {#if url}
                    <Avatar.Image src={url} alt={name} />
                  {/if}
                  <Avatar.Fallback
                    class="accent-gradient text-primary-foreground text-xs font-semibold"
                    style={colour ? `background: ${colour}; color: ${idealTextColor(colour)}` : ''}
                  >
                    {initials}
                  </Avatar.Fallback>
                </Avatar.Root>
              </span>
              <span
                class="truncate text-sm transition-[color,font-weight] duration-200 ease-out {isSpeaking
                  ? 'text-text-bright font-semibold'
                  : 'text-text-base font-medium'}"
                style={colour ? `color: ${colour}` : ''}
              >{name}</span>
              <span class="ml-auto flex shrink-0 items-center gap-1">
                {#if isPartyHost}
                  <span
                    role="button"
                    tabindex="0"
                    onclick={(e) => { e.stopPropagation(); onPartyClick(member.user_id); }}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPartyClick(member.user_id); } }}
                    class="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground hover:bg-primary/90 cursor-pointer"
                    data-testid="member-party-badge"
                    aria-label={m.member_list_item_party_open_label({ name })}
                    title={m.member_list_item_party_open_title()}
                  >PARTY</span>
                {/if}
                {#if isStreaming}
                  <span
                    role="button"
                    tabindex="0"
                    onclick={(e) => { e.stopPropagation(); onActivityClick(member.user_id); }}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onActivityClick(member.user_id); } }}
                    class="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white hover:bg-red-500 cursor-pointer"
                    data-testid="member-live-badge"
                    aria-label={m.member_list_item_stream_open_label({ name })}
                    title={m.member_list_item_stream_open_title()}
                  >LIVE</span>
                {/if}
              </span>
            </button>
          {/snippet}
        </UserProfilePopover>
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  {#if member.user_id !== currentServerUserId() || canQuickRole}
    <ContextMenu.Content>
      {#if member.user_id !== currentServerUserId()}
        <ContextMenu.Item
          onSelect={() => openDmWith(member.user_id)}
          data-testid="member-dm-menu"
        >
          <MessageCircleIcon />
          {m.member_list_item_send_dm()}
        </ContextMenu.Item>
        {#if canQuickRole}<ContextMenu.Separator />{/if}
      {/if}
      {#if canQuickRole}
        <MemberQuickRoleMenu {guildId} userId={member.user_id} />
      {/if}
    </ContextMenu.Content>
  {/if}
</ContextMenu.Root>
