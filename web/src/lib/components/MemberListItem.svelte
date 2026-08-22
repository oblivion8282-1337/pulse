<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import MemberQuickRoleMenu from './MemberQuickRoleMenu.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import { startUserDrag } from '$lib/voice/userDrag';
  import { userCache } from '$lib/stores/users.svelte';
  import { nameColor, nameStyle, idealTextColor } from '$lib/utils/nameColor';
  import { settings } from '$lib/stores/settings.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { memberRoles } from '$lib/stores/memberRoles.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
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
</script>

<UserProfilePopover
  userId={member.user_id}
  displayName={name}
  avatarUrl={url}
  {guildId}
  nickname={member.nickname}
  onAction={onClose}
>
  {#snippet children({ props })}
    <!--
      ``UserProfilePopover`` is itself a right-click context menu now, so
      its trigger props (the ``oncontextmenu`` opener + ``data-state``)
      spread straight onto the row button. Every member therefore gets one
      consistent right-click menu — DM/friend/report/voice-admin actions
      plus the quick-role sub-menu (rendered via ``extra``). Left-click on
      the row does nothing; the PARTY/LIVE badges keep their own click.
    -->
    <button
      {...props}
      type="button"
      class="hover:bg-bg-hover flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors data-[state=open]:bg-bg-hover {isOffline ? 'opacity-50' : ''}"
      data-testid="member-item"
      data-user-id={member.user_id}
      draggable={true}
      ondragstart={(e) => startUserDrag(e, member.user_id)}
    >
      <span class="relative size-8 shrink-0" data-speaking={isSpeaking}>
        {#if isSpeaking}
          <!-- Two staggered rings build the sonar "ping" — identical to
               the voice-channel members list in the left rail. -->
          <span
            class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
            style={settings.appearance.speakingRingNameColor && colour
              ? `border-color: ${colour}`
              : ''}
            aria-hidden="true"
            data-testid="member-speaking-ring"
          ></span>
          <span
            class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
            style={settings.appearance.speakingRingNameColor && colour
              ? `border-color: ${colour}`
              : ''}
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
        style={nameStyle(member.user_id, guildId)}
      >{name}</span>
      <span class="ml-auto flex shrink-0 items-center gap-1">
        {#if isPartyHost}
          <span
            role="button"
            tabindex="0"
            onclick={(e) => { e.stopPropagation(); onPartyClick(member.user_id); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPartyClick(member.user_id); } }}
            class="cursor-pointer rounded bg-badge-party px-1.5 py-0.5 text-2xs font-bold leading-none text-white hover:bg-badge-party-hover"
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
            class="cursor-pointer rounded bg-badge-live px-1.5 py-0.5 text-2xs font-bold leading-none text-white hover:bg-badge-live-hover"
            data-testid="member-live-badge"
            aria-label={m.member_list_item_stream_open_label({ name })}
            title={m.member_list_item_stream_open_title()}
          >LIVE</span>
        {/if}
      </span>
    </button>
  {/snippet}
  {#snippet extra()}
    {#if canQuickRole}
      <div class="mt-3">
        <!-- Im Blatt von unten (Handy) als flache Liste: dort gibt es kein
             Kontextmenue, in dem ein Untermenue aufklappen koennte. -->
        <MemberQuickRoleMenu {guildId} userId={member.user_id} flach={viewport.isMobile} />
      </div>
    {/if}
  {/snippet}
</UserProfilePopover>
