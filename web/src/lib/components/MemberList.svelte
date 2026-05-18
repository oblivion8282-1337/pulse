<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import XIcon from '@lucide/svelte/icons/x';
  import { chatApi } from '$lib/api/chat';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { memberRoles } from '$lib/stores/memberRoles.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { voice } from '$lib/voice/livekit.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { goto } from '$app/navigation';
  import MemberActivityHeader from './MemberActivityHeader.svelte';
  import UserProfilePopover from './UserProfilePopover.svelte';
  import type { Member } from '$lib/api/types';

  let {
    guildId,
    onClose
  }: {
    guildId: string;
    onClose?: () => void;
  } = $props();

  let members = $state<Member[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!guildId) return;
    void load(guildId);
  });

  async function load(id: string) {
    loading = true;
    error = null;
    try {
      members = await chatApi.listMembers(id);
      for (const m of members) {
        userCache.queue(m.user_id);
        // Best-effort lazy role fetch so colour + hoist grouping populate
        // as data arrives. Errors are swallowed — we just stay with the
        // empty role list for that member.
        void memberRoles.ensure(id, m.user_id).catch(() => undefined);
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  type MemberGroup = { hoist: string | null; position: number; members: Member[] };

  /** Group members by their top hoist role (highest-position role with
   * ``hoist=true``). Members without one fall into the ``null`` bucket,
   * which renders as "Online". Groups are sorted by position desc so
   * the top-most hoist role appears first. Within a group, members are
   * alphabetised by display name. */
  let groupedMembers = $derived.by<MemberGroup[]>(() => {
    const byHoist = new Map<string, MemberGroup>();
    for (const m of members) {
      const ids = memberRoles.for(guildId, m.user_id);
      const top = roles.topHoistRole(guildId, ids);
      const key = top?.id ?? '__none__';
      if (!byHoist.has(key)) {
        byHoist.set(key, {
          hoist: top?.name ?? null,
          position: top?.position ?? -1,
          members: []
        });
      }
      byHoist.get(key)!.members.push(m);
    }
    const groups = [...byHoist.values()].sort((a, b) => b.position - a.position);
    for (const g of groups) {
      g.members.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    }
    return groups;
  });

  /** "#RRGGBB" string for the top-coloured role this member holds, or
   * null when nothing applies. Used inline on the username span. */
  function nameColor(userId: string): string | null {
    const ids = memberRoles.for(guildId, userId);
    const top = roles.topColorRole(guildId, ids);
    if (!top) return null;
    return '#' + top.color.toString(16).padStart(6, '0');
  }

  // Per-guild aggregation across all voice channels: who's hosting a watch
  // party + who's HQ-streaming or screen-sharing. Drives the per-row badges
  // below the activity header.
  const guildChannels = $derived(guilds.channelsByGuild[guildId] ?? []);
  const partyHostIds = $derived.by(() => {
    const set = new Set<string>();
    for (const c of guildChannels) {
      const wp = watchPartyPresence.partyIn(c.id);
      if (wp) set.add(wp.host_user_id);
    }
    return set;
  });
  const streamerIds = $derived.by(() => {
    const set = new Set<string>();
    for (const c of guildChannels) {
      for (const uid of streamPresence.streamersIn(c.id)) set.add(uid);
      for (const uid of voicePresence.streamingIn(c.id)) set.add(uid);
    }
    return set;
  });

  // Speaking is live-data — only meaningful for the channel the local user
  // is currently connected to. Skip if that channel doesn't belong to this
  // guild (you're in a voice channel elsewhere).
  const speakingIds = $derived.by(() => {
    if (!voice.connected || !voice.channelId) return new Set<string>();
    if (!guildChannels.some((c) => c.id === voice.channelId)) return new Set<string>();
    const set = new Set<string>();
    for (const p of voice.participants) {
      if (p.isSpeaking && p.userId) set.add(p.userId);
    }
    return set;
  });

  function displayName(m: Member): string {
    if (m.nickname) return m.nickname;
    return userCache.displayName(m.user_id);
  }

  function avatarUrl(m: Member): string | null {
    return safeAvatarUrl(userCache.get(m.user_id)?.avatar_url);
  }

  function initials(m: Member): string {
    return displayName(m).slice(0, 1).toUpperCase();
  }

  function openMemberActivity(uid: string): void {
    // Find any voice channel in this guild where this user is hosting a
    // party or streaming — first match wins (rare to have multiple).
    // Open the matching tiles via openedTiles (HQ + screen-share + party
    // independently, whatever's active), then navigate. VoiceChannelView
    // will mount the grid because hasAny(cid) is now true.
    for (const c of guildChannels) {
      const wp = watchPartyPresence.partyIn(c.id);
      const matchParty = !!wp && wp.host_user_id === uid;
      const matchHq = streamPresence.streamersIn(c.id).includes(uid);
      const matchScreen = voicePresence.streamingIn(c.id).includes(uid);
      if (!matchParty && !matchHq && !matchScreen) continue;
      if (matchParty) {
        if (detachedWatchParties.has(c.id)) detachedWatchParties.open(c.id);
        else openedTiles.openParty(c.id);
      }
      if (matchHq) {
        if (detachedStreams.has(c.id, uid)) detachedStreams.open(c.id, uid);
        else openedTiles.open('hq', c.id, uid);
      }
      if (matchScreen) {
        const ident = voice.connected && voice.channelId === c.id
          ? voice.screenTracks.find((s) => userIdFromIdentity(s.identity) === uid)?.identity
          : undefined;
        if (ident) openedTiles.open('screen', c.id, ident);
      }
      void goto(`/app/guilds/${guildId}/channels/${c.id}`);
      return;
    }
  }
</script>

<aside
  class="border-border bg-bg-chat flex h-full w-full flex-col border-l md:w-44 md:bg-transparent lg:w-52"
  data-testid="member-list"
>
  <header class="flex h-14 items-center justify-between px-4">
    <span class="text-text-muted text-xs font-bold">
      Mitglieder — {members.length}
    </span>
    {#if onClose}
      <button
        class="rounded-full p-1.5 transition-colors hover:bg-bg-hover md:hidden"
        onclick={onClose}
        aria-label="Schließen"
      >
        <XIcon class="text-text-muted size-4" />
      </button>
    {/if}
  </header>

  <MemberActivityHeader {guildId} />

  <div class="flex-1 overflow-y-auto px-2.5 py-1">
    {#if loading}
      <p class="text-text-muted px-3 py-4 text-xs">Lädt…</p>
    {:else if error}
      <p class="px-3 py-4 text-xs text-red-400">{error}</p>
    {:else}
      {#each groupedMembers as group (group.hoist ?? '__none__')}
        <div class="text-text-muted mt-3 px-3 pb-1 text-xs font-semibold uppercase tracking-wide first:mt-0">
          {group.hoist ?? 'Online'} — {group.members.length}
        </div>
        {#each group.members as m (m.user_id)}
        {@const name = displayName(m)}
        {@const url = avatarUrl(m)}
        {@const isSpeaking = speakingIds.has(m.user_id)}
        {@const isPartyHost = partyHostIds.has(m.user_id)}
        {@const isStreaming = streamerIds.has(m.user_id)}
        {@const colour = nameColor(m.user_id)}
        <UserProfilePopover
          userId={m.user_id}
          displayName={name}
          avatarUrl={url}
          onAction={onClose}
        >
          {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class="hover:bg-bg-hover flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors data-[state=open]:bg-bg-hover"
          data-testid="member-item"
          data-user-id={m.user_id}
        >
          <span class="relative size-8 shrink-0" data-speaking={isSpeaking}>
            {#if isSpeaking}
              <!-- Two staggered rings build the sonar "ping" — identical to
                   the voice-channel members list in the left rail. -->
              <span
                class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping"
                aria-hidden="true"
                data-testid="member-speaking-ring"
              ></span>
              <span
                class="pointer-events-none absolute inset-0 rounded-full border-2 border-primary animate-speaking-ping [animation-delay:0.7s]"
                aria-hidden="true"
              ></span>
            {/if}
            <Avatar.Root class="relative size-8">
              {#if url}
                <Avatar.Image src={url} alt={name} />
              {/if}
              <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
                {initials(m)}
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
                onclick={(e) => { e.stopPropagation(); openMemberActivity(m.user_id); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openMemberActivity(m.user_id); } }}
                class="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground hover:bg-primary/90 cursor-pointer"
                data-testid="member-party-badge"
                aria-label="{name}s Watch Party öffnen"
                title="Watch Party öffnen"
              >PARTY</span>
            {/if}
            {#if isStreaming}
              <span
                role="button"
                tabindex="0"
                onclick={(e) => { e.stopPropagation(); openMemberActivity(m.user_id); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openMemberActivity(m.user_id); } }}
                class="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white hover:bg-red-500 cursor-pointer"
                data-testid="member-live-badge"
                aria-label="{name}s Stream öffnen"
                title="Stream öffnen"
              >LIVE</span>
            {/if}
          </span>
        </button>
          {/snippet}
        </UserProfilePopover>
      {/each}
      {/each}
      {#if members.length === 0}
        <p class="text-text-muted px-3 py-4 text-xs">Keine Mitglieder.</p>
      {/if}
    {/if}
  </div>
</aside>
