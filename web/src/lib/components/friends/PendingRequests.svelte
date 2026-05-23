<!--
  Pending tab: incoming requests on top (with Accept/Decline) followed
  by outgoing requests (with Cancel). Both lists are pushed from the
  friendRequests store; the store itself is mutated by REST returns AND
  by WS lifecycle events so a multi-tab user sees everything converge.

  Avatar + name come from userCache (queued on render); for outgoing
  requests we know the receiver via ``r.receiver_id`` directly.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import { friendRequests } from '$lib/stores/friendRequests.svelte';
  import { friends } from '$lib/stores/friends.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { friendsApi } from '$lib/api/friends';
  import { safeAvatarUrl } from '$lib/avatar';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { toast } from 'svelte-sonner';

  $effect(() => {
    for (const r of friendRequests.incomingList) userCache.queue(r.sender_id);
    for (const r of friendRequests.outgoingList) userCache.queue(r.receiver_id);
  });

  async function accept(id: string) {
    try {
      const fr = await friendsApi.acceptRequest(id);
      friendRequests.removeById(id);
      friends.add(fr.user_id, fr.since);
    } catch (e) {
      toast.error('Anfrage konnte nicht akzeptiert werden', {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  async function decline(id: string) {
    try {
      await friendsApi.declineRequest(id);
      friendRequests.removeIncoming(id);
    } catch (e) {
      toast.error('Anfrage konnte nicht abgelehnt werden');
    }
  }

  async function cancel(id: string) {
    try {
      await friendsApi.cancelRequest(id);
      friendRequests.removeOutgoing(id);
    } catch (e) {
      toast.error('Anfrage konnte nicht zurückgezogen werden');
    }
  }
</script>

<section class="flex flex-col gap-6" data-testid="pending-tab">
  <div>
    <h2 class="text-text-bright px-1 pb-2 text-xs font-semibold uppercase tracking-wide">
      Eingehend — {friendRequests.incomingList.length}
    </h2>
    {#if friendRequests.incomingList.length === 0}
      <p class="text-text-muted px-1 py-3 text-sm" data-testid="pending-in-empty">
        Keine offenen Anfragen.
      </p>
    {/if}
    {#each friendRequests.incomingList as r (r.id)}
      {@const u = userCache.get(r.sender_id)}
      {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
      <div
        class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-2"
        data-testid="pending-in-row"
        data-request-id={r.id}
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
          <p class="text-text-muted truncate text-xs">möchte dich als Freund hinzufügen</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => accept(r.id)}
          data-testid="pending-accept-btn"
          title="Annehmen"
        >
          <CheckIcon class="size-4 text-emerald-400" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => decline(r.id)}
          data-testid="pending-decline-btn"
          title="Ablehnen"
        >
          <XIcon class="size-4 text-rose-400" />
        </Button>
      </div>
    {/each}
  </div>
  <div>
    <h2 class="text-text-bright px-1 pb-2 text-xs font-semibold uppercase tracking-wide">
      Ausgehend — {friendRequests.outgoingList.length}
    </h2>
    {#if friendRequests.outgoingList.length === 0}
      <p class="text-text-muted px-1 py-3 text-sm" data-testid="pending-out-empty">
        Keine ausstehenden Einladungen.
      </p>
    {/if}
    {#each friendRequests.outgoingList as r (r.id)}
      {@const u = userCache.get(r.receiver_id)}
      {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
      <div
        class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-2"
        data-testid="pending-out-row"
        data-request-id={r.id}
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
          <p class="text-text-muted truncate text-xs">Wartet auf Antwort</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => cancel(r.id)}
          data-testid="pending-cancel-btn"
          title="Zurückziehen"
        >
          <XIcon class="size-4" />
        </Button>
      </div>
    {/each}
  </div>
</section>
