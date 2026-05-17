<script lang="ts">
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import XIcon from '@lucide/svelte/icons/x';
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { streamOpenRequest } from '$lib/stores/streamOpenRequest.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { goto } from '$app/navigation';
  import MemberActivityHeader from './MemberActivityHeader.svelte';
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
      for (const m of members) userCache.queue(m.user_id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
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

  async function startDM(uid: string): Promise<void> {
    if (auth.user && uid === auth.user.id) return; // no self-DM
    try {
      const dm = await chatApi.createOrGetDMChannel(uid);
      // Seed the store so the sidebar picks it up immediately — otherwise
      // it'd only appear on the next hydrate / ready.
      directMessages.upsert(dm);
      onClose?.();
      await goto(`/app/@me/${dm.id}`);
    } catch (err) {
      toast.error('DM konnte nicht geöffnet werden', {
        description: err instanceof Error ? err.message : String(err)
      });
    }
  }

  function openMemberActivity(uid: string): void {
    // Find any voice channel in this guild where this user is hosting a
    // party or streaming — first match wins (rare to have multiple). Set
    // the open-request first, then navigate; VoiceChannelView consumes the
    // request on (re)mount and pops the stream view open immediately.
    for (const c of guildChannels) {
      const wp = watchPartyPresence.partyIn(c.id);
      const matchParty = wp && wp.host_user_id === uid;
      const matchStream =
        streamPresence.streamersIn(c.id).includes(uid) ||
        voicePresence.streamingIn(c.id).includes(uid);
      if (matchParty || matchStream) {
        streamOpenRequest.request(c.id);
        void goto(`/app/guilds/${guildId}/channels/${c.id}`);
        return;
      }
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
      {#each members as m (m.user_id)}
        {@const name = displayName(m)}
        {@const url = avatarUrl(m)}
        {@const isSpeaking = speakingIds.has(m.user_id)}
        {@const isPartyHost = partyHostIds.has(m.user_id)}
        {@const isStreaming = streamerIds.has(m.user_id)}
        {@const isSelf = !!auth.user && m.user_id === auth.user.id}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            {#snippet child({ props })}
        <div
          {...props}
          class="group hover:bg-bg-hover flex items-center gap-2.5 rounded-xl px-3 py-2"
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
          >{name}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1">
            {#if isPartyHost}
              <button
                type="button"
                onclick={() => openMemberActivity(m.user_id)}
                class="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-primary-foreground hover:bg-primary/90"
                data-testid="member-party-badge"
                aria-label="{name}s Watch Party öffnen"
                title="Watch Party öffnen"
              >PARTY</button>
            {/if}
            {#if isStreaming}
              <button
                type="button"
                onclick={() => openMemberActivity(m.user_id)}
                class="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white hover:bg-red-500"
                data-testid="member-live-badge"
                aria-label="{name}s Stream öffnen"
                title="Stream öffnen"
              >LIVE</button>
            {/if}
            {#if !isSelf}
              <button
                type="button"
                onclick={() => startDM(m.user_id)}
                class="text-text-muted hover:text-primary rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                data-testid="member-dm-btn"
                aria-label="Nachricht an {name} senden"
                title="Nachricht senden"
              >
                <MessageCircleIcon class="size-4" />
              </button>
            {/if}
          </span>
        </div>
            {/snippet}
          </ContextMenu.Trigger>
          {#if !isSelf}
            <ContextMenu.Content>
              <ContextMenu.Item onSelect={() => startDM(m.user_id)} data-testid="member-dm-menu">
                <MessageCircleIcon />
                Nachricht senden
              </ContextMenu.Item>
            </ContextMenu.Content>
          {/if}
        </ContextMenu.Root>
      {/each}
      {#if members.length === 0}
        <p class="text-text-muted px-3 py-4 text-xs">Keine Mitglieder.</p>
      {/if}
    {/if}
  </div>
</aside>
