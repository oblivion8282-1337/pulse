<script lang="ts">
  import XIcon from '@lucide/svelte/icons/x';
  import MemberListItem from './MemberListItem.svelte';
  import { useGatewayListener } from '$lib/ws/useGatewayListener.svelte';
  import { chatApi } from '$lib/api/chat';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { memberRoles } from '$lib/stores/memberRoles.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { rolesApi } from '$lib/api/roles';
  import { Perm } from '$lib/permissions/bitfield';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { chooseHqForUser } from '$lib/stream/hqTile';
  import { watchPartyPicker, openPartyTile } from '$lib/watch/openParty.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { voice } from '$lib/voice/livekit.svelte';
  import { goto } from '$app/navigation';
  import MemberActivityHeader from './MemberActivityHeader.svelte';
  import type { Member } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

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
  // Quick-role menu only renders if the viewer actually has MANAGE_ROLES
  // — otherwise the right-click would pop an empty ContextMenu.Content,
  // which bits-ui still mounts as an empty floating element. Guarding
  // here keeps the default right-click behaviour intact for everyone else.
  let canQuickRole = $derived(roles.hasGuildPermission(guildId, Perm.MANAGE_ROLES));

  $effect(() => {
    if (!guildId) return;
    void load(guildId);
  });

  // React to guild-member events pushed via guild:events. Keeps the
  // open member list in sync without forcing a refetch. Über
  // `useGatewayListener` — wandert beim Server-Switch mit (Phase 4.5).
  useGatewayListener((evt) => {
    if (evt.op === 'guild_member_updated' && evt.guild_id === guildId) {
      members = members.map((m) =>
        m.user_id === evt.user_id ? { ...m, nickname: evt.nickname } : m
      );
    } else if (evt.op === 'guild_member_removed' && evt.guild_id === guildId) {
      members = members.filter((m) => m.user_id !== evt.user_id);
    }
  });

  async function load(id: string) {
    loading = true;
    error = null;
    try {
      members = await chatApi.listMembers(id);
      for (const m of members) userCache.queue(m.user_id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
    // Role-id fetch is fire-and-forget so it never blocks the members
    // render — the colour + hoist grouping populate as the data lands.
    void rolesApi
      .bulkMemberRoles(id)
      .then((bulk) => {
        memberRoles.seedAll(id, bulk, members.map((m) => m.user_id));
      })
      .catch(() => {
        /* per-member ``ensure`` on the next render is the fallback */
      });
  }

  // hoistId (stabile, eindeutige Rollen-Snowflake) ist der {#each}-Key; hoist
  // (Name) ist nur fürs Label. Zwei gleichnamige Hoist-Rollen (in Discord-artigen
  // Systemen erlaubt) erzeugen sonst doppelte {#each}-Keys → Svelte-5-Fehler /
  // Fehl-Render; ein Rename würde die DOM-Gruppe unnötig zerstören+neu bauen.
  type MemberGroup = {
    hoistId: string | null;
    hoist: string | null;
    position: number;
    members: Member[];
    offline?: boolean;
  };

  function sortName(m: Member): string {
    return m.nickname ?? userCache.displayName(m.user_id);
  }

  /** Group members by online/offline, then by hoist role within the online
   * section. Offline members collapse into a single group at the bottom.
   * Groups are sorted by hoist-role position desc; within a group members
   * are alphabetised by display name. */
  let groupedMembers = $derived.by<MemberGroup[]>(() => {
    const online: Member[] = [];
    const offline: Member[] = [];
    for (const m of members) {
      if (presence.isOnline(m.user_id)) online.push(m);
      else offline.push(m);
    }

    const byHoist = new Map<string, MemberGroup>();
    for (const m of online) {
      const ids = memberRoles.for(guildId, m.user_id);
      const top = roles.topHoistRole(guildId, ids);
      const key = top?.id ?? '__none__';
      if (!byHoist.has(key)) {
        byHoist.set(key, {
          hoistId: top?.id ?? null,
          hoist: top?.name ?? null,
          position: top?.position ?? -1,
          members: [],
        });
      }
      byHoist.get(key)!.members.push(m);
    }
    const onlineGroups = [...byHoist.values()].sort((a, b) => b.position - a.position);
    for (const g of onlineGroups) {
      const keyed = g.members.map((m) => [m, sortName(m)] as const);
      keyed.sort(([, a], [, b]) => a.localeCompare(b));
      g.members = keyed.map(([m]) => m);
    }

    if (offline.length === 0) return onlineGroups;
    const offlineKeyed = offline.map((m) => [m, sortName(m)] as const);
    offlineKeyed.sort(([, a], [, b]) => a.localeCompare(b));
    const sortedOffline = offlineKeyed.map(([m]) => m);
    return [
      ...onlineGroups,
      { hoistId: null, hoist: null, position: -999, members: sortedOffline, offline: true },
    ];
  });

  // Per-guild aggregation across all voice channels: who's hosting a watch
  // party + who's HQ-streaming or screen-sharing. Drives the per-row badges
  // below the activity header.
  //
  // Privacy: an *invisible* user is masked to offline (presence.isOnline false)
  // and groups under "offline" — but their stream/voice/watch presence rides on
  // separate, un-masked stores. Gate every activity badge on isOnline so an
  // invisible user doesn't leak that they're streaming / hosting a party.
  // (A genuinely-offline user can't be live, so this only ever hides invisibles.)
  const guildChannels = $derived(guilds.channelsByGuild[guildId] ?? []);
  const partyHostIds = $derived.by(() => {
    const set = new Set<string>();
    for (const c of guildChannels) {
      for (const uid of watchPartyPresence.hostIdsIn(c.id)) {
        if (presence.isOnline(uid)) set.add(uid);
      }
    }
    return set;
  });
  const streamerIds = $derived.by(() => {
    const set = new Set<string>();
    for (const c of guildChannels) {
      for (const uid of streamPresence.streamersIn(c.id)) {
        if (presence.isOnline(uid)) set.add(uid);
      }
      for (const uid of voicePresence.streamingIn(c.id)) {
        if (presence.isOnline(uid)) set.add(uid);
      }
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
      // Privacy: ein unsichtbarer (maskiert-offline) User darf in der Roster-
      // Liste keinen Sprech-Indikator zeigen — sonst verrät er sich trotz
      // Offline-Anzeige. (In der Voice-Liste selbst bleibt er sichtbar — da
      // ist man ohnehin mit ihm im Call.)
      if (p.isSpeaking && p.userId && presence.isOnline(p.userId)) set.add(p.userId);
    }
    return set;
  });

  function openMemberActivity(uid: string): void {
    // LIVE badge: find the first voice channel in this guild where this user is
    // HQ-streaming or screen-sharing, open those tiles, then navigate. Parties
    // are handled separately by openMemberParty (its own badge).
    for (const c of guildChannels) {
      const matchHq = streamPresence.streamersIn(c.id).includes(uid);
      const matchScreen = voicePresence.streamingIn(c.id).includes(uid);
      if (!matchHq && !matchScreen) continue;
      if (matchHq) {
        chooseHqForUser(c.id, uid);
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

  function openMemberParty(uid: string): void {
    // PARTY badge: collect every party this user hosts across the guild's voice
    // channels. One → open + navigate directly; several → chooser dialog.
    const entries = guildChannels.flatMap((c) =>
      watchPartyPresence.partiesHostedBy(c.id, uid).map((party) => ({
        id: party.party_id,
        party,
        suffix: `#${c.name}`,
        open: () => {
          openPartyTile(c.id, party);
          void goto(`/app/guilds/${guildId}/channels/${c.id}`);
        }
      }))
    );
    watchPartyPicker.choose(entries, m.watch_party_picker_title());
  }
</script>

<aside
  class="border-border bg-bg-chat flex h-full w-full flex-col border-l md:w-44 md:bg-transparent lg:w-52"
  data-testid="member-list"
>
  <header class="flex h-14 items-center justify-between px-4">
    <span class="text-text-muted text-xs font-bold">
      {m.member_list_header_count({ count: members.length })}
    </span>
    {#if onClose}
      <button
        class="rounded-full p-1.5 transition-colors hover:bg-bg-hover md:hidden"
        onclick={onClose}
        aria-label={m.member_list_close()}
      >
        <XIcon class="text-text-muted size-4" />
      </button>
    {/if}
  </header>

  <MemberActivityHeader {guildId} />

  <div class="flex-1 overflow-y-auto px-2.5 py-1">
    {#if loading}
      <p class="text-text-muted px-3 py-4 text-xs">{m.member_list_loading()}</p>
    {:else if error}
      <p class="px-3 py-4 text-xs text-red-400">{error}</p>
    {:else}
      {#each groupedMembers as group (group.offline ? '__offline__' : (group.hoistId ?? '__none__'))}
        <div class="text-text-muted mt-3 px-3 pb-1 text-xs font-semibold uppercase tracking-wide first:mt-0">
          {m.member_list_group_label({ label: group.offline ? m.member_list_offline() : (group.hoist ?? m.member_list_online()), count: group.members.length })}
        </div>
        {#each group.members as m (m.user_id)}
          <MemberListItem
            member={m}
            {guildId}
            isSpeaking={speakingIds.has(m.user_id)}
            isPartyHost={partyHostIds.has(m.user_id)}
            isStreaming={streamerIds.has(m.user_id)}
            isOffline={!!group.offline}
            {canQuickRole}
            onActivityClick={openMemberActivity}
            onPartyClick={openMemberParty}
            {onClose}
          />
        {/each}
      {/each}
      {#if members.length === 0}
        <p class="text-text-muted px-3 py-4 text-xs">{m.member_list_empty()}</p>
      {/if}
    {/if}
  </div>
</aside>
