<!--
  Friends-Tab content. Lists confirmed friendships from the friends store,
  optionally filtered to currently-online peers (drives the "Online"
  sub-tab without needing a second store).

  Avatar + display name come from the shared userCache (queued lazily so
  freshly-added friends resolve without a manual hydrate). Status dot
  reads `presence.displayStatus(user_id)` — matches the masked value the
  server delivers (invisible peers appear as offline here, by design).

  Actions in Etappe 4 are minimal foundation: "Nachricht senden" (creates
  or opens the DM channel) and "Entfernen" (unfriend). Block + profile
  card land in Etappe 5 — the popover surface is the GuildRail-side
  UserProfilePopover, not this row.
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
  import { friendsApi } from '$lib/api/friends';
  import { chatApi } from '$lib/api/chat';
  import { safeAvatarUrl } from '$lib/avatar';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let { onlineOnly = false }: { onlineOnly?: boolean } = $props();

  $effect(() => {
    for (const f of friends.list) userCache.queue(f.user_id);
  });

  const visible = $derived(
    onlineOnly
      ? friends.list.filter((f) => presence.displayStatus(f.user_id) !== 'offline')
      : friends.list
  );

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
              <p class="text-text-bright truncate text-sm font-semibold">
                {u?.display_name ?? u?.username ?? '…'}
              </p>
              <p class="text-text-muted truncate text-xs">{status}</p>
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
