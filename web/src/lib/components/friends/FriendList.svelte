<!--
  Friends-Tab content. Lists confirmed friendships from the friends store,
  optionally filtered to currently-online peers.

  Pro Freund (online): übersetzter Status + Voice-Channel-Context + LIVE-/
  PARTY-Badge (wenn er streamt bzw. eine Watch-Party hostet). Klick auf den
  Freund: mit Voice/Stream-Kontext → dessen Community öffnen (Kanal-Liste,
  KEIN Voice-Join); sonst → Profil-Popover. Voice/Stream/Party-Daten kommen
  nur für Channels eigener Communities (Server filtert VIEW_CHANNEL);
  offline/unsichtbar erscheinen ohnehin nicht.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Button } from '$lib/components/ui/button/index.js';
  import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import UserProfilePopover from '$lib/components/UserProfilePopover.svelte';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { presence } from '$lib/stores/presence.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { friendsApi } from '$lib/api/friends';
  import { chatApi } from '$lib/api/chat';
  import { safeAvatarUrl } from '$lib/avatar';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let { onlineOnly = false }: { onlineOnly?: boolean } = $props();

  $effect(() => {
    for (const f of friends.list) userCache.queue(f.user_id);
  });

  // Channels eigener Guilds lazy laden, damit Voice-/Stream-Channel-IDs auf
  // Namen/Guild auflösen. ensureChannels dedupet — Wiederholungen sind billig.
  $effect(() => {
    for (const g of guilds.list) void guilds.ensureChannels(g.id).catch(() => undefined);
  });

  const visible = $derived(
    onlineOnly
      ? friends.list.filter((f) => presence.displayStatus(f.user_id) !== 'offline')
      : friends.list
  );

  // Voice-Channel je Freund (Reverse-Lookup über voicePresence.byChannel).
  // Liefert nur Channels eigener Communities (Server filtert VIEW_CHANNEL).
  const voiceByUser = $derived.by(() => {
    const map = new Map<string, { channelName: string; guildId: string; guildName: string }>();
    for (const [channelId, userIds] of Object.entries(voicePresence.byChannel)) {
      const guildId = guilds.guildIdForChannel(channelId);
      if (!guildId) continue;
      const ch = (guilds.channelsByGuild[guildId] ?? []).find((c) => c.id === channelId);
      if (!ch) continue;
      const guildName = guilds.byId[guildId]?.name ?? '';
      for (const uid of userIds) map.set(uid, { channelName: ch.name, guildId, guildName });
    }
    return map;
  });

  // Erster Channel, in dem `uid` laut `byChannel`-Map aktiv ist. `valueMatches`
  // prüft den Per-Channel-Wert (string[] der User-IDs bzw. Party-Map).
  function findChannel<T>(
    byChannel: Record<string, T>,
    valueMatches: (value: T) => boolean
  ): string | null {
    for (const [channelId, value] of Object.entries(byChannel)) {
      if (valueMatches(value)) return channelId;
    }
    return null;
  }

  function statusLabel(status: string): string {
    switch (status) {
      case 'online':
        return m.friend_status_online();
      case 'idle':
        return m.friend_status_idle();
      case 'dnd':
        return m.friend_status_dnd();
      default:
        return m.friend_status_offline();
    }
  }

  async function openDM(userId: string) {
    try {
      const dm = await chatApi.createOrGetDMChannel(userId);
      await goto(`/app/@me/${dm.id}`);
    } catch (e) {
      toast.error(m.friend_list_dm_open_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  async function unfriend(userId: string) {
    if (!confirm(m.friend_list_unfriend_confirm())) return;
    try {
      await friendsApi.removeFriend(userId);
      friends.remove(userId);
    } catch (e) {
      toast.error(m.friend_list_unfriend_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }
</script>

<section class="flex flex-col gap-1" data-testid="friends-list">
  <h2 class="text-text-bright px-1 pb-2 text-xs font-semibold uppercase tracking-wide">
    {onlineOnly ? m.friend_list_heading_online() : m.friend_list_heading_all()} — {visible.length}
  </h2>
  {#if visible.length === 0}
    <p class="text-text-muted px-1 py-4 text-sm" data-testid="friends-empty">
      {onlineOnly ? m.friend_list_empty_online() : m.friend_list_empty_all()}
    </p>
  {/if}
  {#each visible as f (f.user_id)}
    {@const u = userCache.get(f.user_id)}
    {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
    {@const status = presence.displayStatus(f.user_id)}
    {@const vc = voiceByUser.get(f.user_id)}
    {@const stream = findChannel(streamPresence.byChannel, (ids) => ids.includes(f.user_id))}
    {@const party = findChannel(watchPartyPresence.byChannel, (parties) =>
      Object.values(parties).some((p) => p.host_user_id === f.user_id))}
    {@const ctxGuild = vc?.guildId ?? guilds.guildIdForChannel(stream ?? party ?? '')}
    <div
      class="hover:bg-bg-hover group flex items-center gap-3 rounded-lg px-2 py-2"
      data-testid="friend-row"
      data-user-id={f.user_id}
    >
      <UserProfilePopover
        userId={f.user_id}
        displayName={u?.display_name ?? u?.username ?? '…'}
        avatarUrl={avatar}
      >
        {#snippet children({ props })}
          <button
            {...props}
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            data-testid="friend-profile-trigger"
            onclick={(e) => {
              if (ctxGuild) {
                e.stopPropagation();
                void goto(`/app/guilds/${ctxGuild}/channels/_`);
              } else {
                // Mit Voice/Stream springen wir in die Community; sonst den
                // bits-ui Popover.Trigger-Toggle (props.onclick) erhalten.
                (props.onclick as ((e: MouseEvent) => void) | undefined)?.(e);
              }
            }}
          >
            <div class="relative shrink-0">
              <Avatar.Root class="size-9">
                {#if avatar}
                  <Avatar.Image src={avatar} alt="" />
                {/if}
                <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
                  {(u?.display_name ?? u?.username ?? '?').slice(0, 1).toUpperCase()}
                </Avatar.Fallback>
              </Avatar.Root>
              <StatusDot {status} class="ring-bg-base absolute -right-0.5 -bottom-0.5 size-3 ring-2" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-text-bright flex items-center gap-1.5 truncate text-sm font-semibold">
                <span class="truncate">{u?.display_name ?? u?.username ?? '…'}</span>
                {#if stream}
                  <span
                    class="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-400"
                  >
                    <span class="size-1.5 rounded-full bg-red-500"></span>
                    {m.friend_badge_live()}
                  </span>
                {/if}
                {#if party}
                  <span
                    class="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-400"
                  >
                    <span class="size-1.5 rounded-full bg-amber-400"></span>
                    {m.friend_badge_party()}
                  </span>
                {/if}
              </p>
              <p class="text-text-muted truncate text-xs">
                {statusLabel(status)}{#if vc} · {m.friend_in_voice({ channel: vc.channelName, guild: vc.guildName })}{/if}
              </p>
            </div>
          </button>
        {/snippet}
      </UserProfilePopover>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => openDM(f.user_id)}
        data-testid="friend-dm-btn"
        title={m.friend_list_action_send_message()}
      >
        <MessageCircleIcon class="size-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => unfriend(f.user_id)}
        data-testid="friend-remove-btn"
        title={m.friend_list_action_remove()}
      >
        <UserMinusIcon class="size-4" />
      </Button>
    </div>
  {/each}
</section>
