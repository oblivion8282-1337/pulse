<!--
  WatchPartyHandoffMenu — host-only "hand off control" picker. Lists the
  current watchers (minus the host) plus an "automatic (next oldest)" option;
  selecting one sends a watch_handoff op. Split out of WatchPartyTile to keep
  that component under the size cap.
-->
<script lang="ts">
  import UsersIcon from '@lucide/svelte/icons/users';
  import { m } from '$lib/paraglide/messages.js';
  import { gateway } from '$lib/ws/connection';
  import { userCache } from '$lib/stores/users.svelte';

  interface Props {
    channelId: string;
    partyId: string;
    /** Watcher user-ids excluding the host. */
    others: string[];
  }
  let { channelId, partyId, others }: Props = $props();

  let open = $state(false);

  $effect(() => {
    for (const uid of others) userCache.queue(uid);
  });

  function handoff(target?: string): void {
    gateway.sendWatchHandoff(channelId, partyId, target);
    open = false;
  }
</script>

<div class="relative">
  <button
    type="button"
    onclick={() => (open = !open)}
    class="flex items-center justify-center rounded-full bg-black/55 p-3 text-white backdrop-blur-sm hover:bg-black/75 md:p-1.5"
    aria-label={m.watch_party_tile_handoff_aria()}
    title={m.watch_party_tile_handoff_aria()}
    data-testid="watch-party-handoff"
  >
    <UsersIcon class="size-5 md:size-3.5" />
  </button>
  {#if open}
    <div
      class="absolute right-0 bottom-full mb-2 min-w-44 rounded-xl bg-black/90 p-1 text-sm text-white shadow-lg backdrop-blur-sm"
      data-testid="watch-party-handoff-menu"
    >
      <button
        type="button"
        class="block w-full rounded px-3 py-2 text-left hover:bg-white/10 disabled:opacity-40"
        disabled={others.length === 0}
        onclick={() => handoff()}
      >
        {m.watch_party_tile_handoff_auto()}
      </button>
      {#each others as uid (uid)}
        <button
          type="button"
          class="block w-full truncate rounded px-3 py-2 text-left hover:bg-white/10"
          onclick={() => handoff(uid)}
        >
          {m.watch_party_tile_handoff_to({ name: userCache.displayName(uid) })}
        </button>
      {/each}
    </div>
  {/if}
</div>
