<!--
  "Add friend" tab: username search with 300ms debounce + Add button per
  hit. The auth-svc search filters out the caller and any user with
  ``discoverable=false``, so the visible list is already valid targets.

  Existing relationships are surfaced inline: friends + outgoing-pending
  + blocked rows render disabled badges instead of an Add button so the
  user doesn't double-click into a 409.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { friendsApi, type UserSearchHit } from '$lib/api/friends';
  import { friends } from '$lib/stores/friends.svelte';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import { blocks } from '$lib/stores/blocks.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let query = $state('');
  let hits = $state<UserSearchHit[]>([]);
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // In-Flight-Anfragen pro userId: ohne Guard schickt ein Doppelklick zwei
  // POSTs — der zweite kollidiert mit dem ersten (Backend: 409
  // request_already_pending) und zeigt fälschlich einen Fehler-Toast.
  let pending = $state<Set<string>>(new Set());

  $effect(() => {
    const q = query.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.length < 2) {
      hits = [];
      searchError = null;
      searching = false;
      return;
    }
    debounceTimer = setTimeout(() => {
      void runSearch(q);
    }, 300);
  });

  async function runSearch(q: string) {
    searching = true;
    searchError = null;
    try {
      const result = await friendsApi.searchUsers(q);
      // Race-guard: a faster typist may have changed `query` while we
      // were waiting; only commit the freshest result.
      if (query.trim() !== q) return;
      hits = result;
      for (const h of result) userCache.queue(h.id);
    } catch (e) {
      searchError = e instanceof Error ? e.message : m.add_friend_search_failed();
      hits = [];
    } finally {
      if (query.trim() === q) searching = false;
    }
  }

  function relationLabel(userId: string): string | null {
    if (friends.has(userId)) return m.add_friend_relation_already_friends();
    if (blocks.has(userId)) return m.add_friend_relation_blocked();
    for (const r of friendRequests.outgoingList) {
      if (r.receiver_id === userId) return m.add_friend_relation_request_pending();
    }
    for (const r of friendRequests.incomingList) {
      if (r.sender_id === userId) return m.add_friend_relation_incoming();
    }
    return null;
  }

  async function add(userId: string) {
    if (pending.has(userId)) return;
    pending = new Set([...pending, userId]);
    try {
      const res = await friendsApi.sendFriendRequest(userId);
      if ('auto_accepted' in res && res.auto_accepted) {
        friends.add(res.friendship.user_id, res.friendship.since);
        toast.success(m.add_friend_auto_accepted());
      } else if ('id' in res) {
        // Narrowing on the discriminator: pending FriendRequest payload.
        friendRequests.addOutgoing(res);
        toast.success(m.add_friend_request_sent());
      }
    } catch (e) {
      toast.error(m.add_friend_request_failed(), {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      const next = new Set(pending);
      next.delete(userId);
      pending = next;
    }
  }
</script>

<section class="flex flex-col gap-3" data-testid="add-friend-tab">
  <p class="text-text-muted text-sm">
    {m.add_friend_hint()}
  </p>
  <Input
    type="text"
    bind:value={query}
    placeholder={m.add_friend_input_placeholder()}
    data-testid="add-friend-input"
    autocomplete="off"
  />
  {#if searching}
    <p class="text-text-muted px-1 text-xs">{m.add_friend_searching()}</p>
  {/if}
  {#if searchError}
    <p class="px-1 text-xs text-rose-400">{searchError}</p>
  {/if}
  {#if !searching && query.trim().length >= 2 && hits.length === 0 && !searchError}
    <p class="text-text-muted px-1 py-2 text-sm" data-testid="add-friend-no-results">
      {m.add_friend_no_results()}
    </p>
  {/if}
  {#each hits as h (h.id)}
    {@const avatar = safeAvatarUrl(h.avatar_url)}
    {@const label = relationLabel(h.id)}
    <div
      class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-2"
      data-testid="search-hit"
      data-user-id={h.id}
    >
      <Avatar.Root class="size-9 shrink-0">
        {#if avatar}
          <Avatar.Image src={avatar} alt="" />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
          {(h.display_name ?? h.username).slice(0, 1).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <p class="text-text-bright truncate text-sm font-semibold">
          {h.display_name ?? h.username}
        </p>
        <p class="text-text-muted truncate text-xs">@{h.username}</p>
      </div>
      {#if label}
        <span class="text-text-muted text-xs" data-testid="search-hit-status">{label}</span>
      {:else}
        <Button
          size="sm"
          variant="default"
          onclick={() => add(h.id)}
          disabled={pending.has(h.id)}
          data-testid="search-hit-add"
        >
          <UserPlusIcon class="mr-1 size-4" /> {m.add_friend_add_button()}
        </Button>
      {/if}
    </div>
  {/each}
</section>
