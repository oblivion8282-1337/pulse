<!--
  Blocked-users tab. Hydrates the blocks store via GET /blocks on mount
  (the ready frame only carries the id list, not the timestamps — the
  full call gives us "since" + lets the user inspect when the block was
  set up).

  Single action per row: "Entsperren". User-popover / profile lands in
  Etappe 5 — Etappe 4 just exposes the foundation.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import UserMinusIcon from '@lucide/svelte/icons/user-minus';
  import { blocks } from '$lib/stores/blocks.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { friendsApi } from '$lib/api/friends';
  import { safeAvatarUrl } from '$lib/avatar';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { toast } from 'svelte-sonner';

  onMount(async () => {
    try {
      const rows = await friendsApi.listBlocks();
      blocks.hydrate(rows);
    } catch {
      // ready-seeded ids stay visible; toast would be noisy here
    }
  });

  $effect(() => {
    for (const b of blocks.list) userCache.queue(b.user_id);
  });

  async function unblock(userId: string) {
    try {
      await friendsApi.unblockUser(userId);
      blocks.remove(userId);
    } catch (e) {
      toast.error('Entsperren fehlgeschlagen', {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }
</script>

<section class="flex flex-col gap-1" data-testid="blocked-tab">
  <h2 class="text-text-bright px-1 pb-2 text-xs font-semibold uppercase tracking-wide">
    Blockiert — {blocks.list.length}
  </h2>
  {#if blocks.list.length === 0}
    <p class="text-text-muted px-1 py-4 text-sm" data-testid="blocked-empty">
      Niemand blockiert.
    </p>
  {/if}
  {#each blocks.list as b (b.user_id)}
    {@const u = userCache.get(b.user_id)}
    {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
    <div
      class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-2"
      data-testid="blocked-row"
      data-user-id={b.user_id}
    >
      <Avatar.Root class="size-9 shrink-0">
        {#if avatar}
          <Avatar.Image src={avatar} alt="" />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
          {(u?.display_name ?? u?.username ?? '?').slice(0, 1).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <p class="text-text-bright truncate text-sm font-semibold">
          {u?.display_name ?? u?.username ?? '…'}
        </p>
        <p class="text-text-muted truncate text-xs">blockiert</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => unblock(b.user_id)}
        data-testid="blocked-unblock-btn"
      >
        <UserMinusIcon class="size-4" /> Entsperren
      </Button>
    </div>
  {/each}
</section>
