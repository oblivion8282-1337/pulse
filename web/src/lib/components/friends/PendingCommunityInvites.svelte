<!--
  Pending Community Invites — zeigt eingehende Community-Einladungen mit
  „Beitreten"- und „Ablehnen"-Buttons.

  „Beitreten": `acceptCommunityInvite(inv)` — handelt Cloud vs. Self-Host automatisch.
  „Ablehnen":  `communityInvitesApi.remove(inv.id)` + store.remove.

  Daten kommen aus communityInvites-Store (geseedet beim App-Init + WS-Events).
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import { communityInvites } from '$lib/stores/communityInvites.svelte';
  import { communityInvitesApi, type CommunityInvitePayload } from '$lib/api/community-invites';
  import {
    acceptCommunityInvite,
    SelfHostContactConfirmRequired,
    BackupRequiredError
  } from '$lib/api/add-server-flow';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import SelfHostContactConfirmDialog from '$lib/components/server/SelfHostContactConfirmDialog.svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';

  let joiningId = $state<string | null>(null);

  // Erstkontakt-Bestätigung für neue, unbekannte Self-Hosts.
  let confirmOpen = $state(false);
  let confirmHost = $state('');
  let pendingInvite = $state<CommunityInvitePayload | null>(null);

  $effect(() => {
    for (const inv of communityInvites.incomingList) {
      userCache.queue(inv.inviter_id);
    }
  });

  /** Führt den Join aus. Bei einem unbestätigten neuen Self-Host wird der
   *  Bestätigungs-Dialog geöffnet statt direkt zu kontaktieren. */
  async function runJoin(inv: CommunityInvitePayload, confirmed: boolean) {
    joiningId = inv.id;
    try {
      await acceptCommunityInvite(inv, confirmed);
      communityInvites.remove(inv.id);
    } catch (e) {
      // Bewusster Abbruch des Backup-Setups → still verwerfen, kein Fehler-Toast.
      if (e instanceof BackupRequiredError) {
        joiningId = null;
        return;
      }
      if (e instanceof SelfHostContactConfirmRequired) {
        // Erstkontakt-Gate: Dialog öffnen, auf Bestätigung warten.
        confirmHost = e.hostname;
        pendingInvite = inv;
        confirmOpen = true;
        joiningId = null;
        return;
      }
      toast.error(m.pending_community_invites_accept_error(), {
        description: e instanceof Error ? e.message : undefined
      });
    } finally {
      if (!confirmOpen) joiningId = null;
    }
  }

  function join(id: string) {
    const inv = communityInvites.incomingList.find((i) => i.id === id);
    if (!inv || joiningId) return;
    void runJoin(inv, false);
  }

  function onConfirmContact() {
    const inv = pendingInvite;
    confirmOpen = false;
    pendingInvite = null;
    if (inv) void runJoin(inv, true);
  }

  function onCancelContact() {
    confirmOpen = false;
    pendingInvite = null;
    joiningId = null;
  }

  async function decline(id: string) {
    try {
      await communityInvitesApi.remove(id);
      communityInvites.remove(id);
    } catch (e) {
      toast.error(m.pending_community_invites_decline_error());
    }
  }
</script>

<section class="flex flex-col gap-2" data-testid="pending-community-invites">
  <h2 class="text-text-bright px-1 pb-2 text-xs font-semibold uppercase tracking-wide">
    {m.pending_community_invites_heading({ count: communityInvites.incomingList.length })}
  </h2>
  {#if communityInvites.incomingList.length === 0}
    <p class="text-text-muted px-1 py-3 text-sm" data-testid="pending-community-empty">
      {m.pending_community_invites_empty()}
    </p>
  {/if}
  {#each communityInvites.incomingList as inv (inv.id)}
    {@const inviter = userCache.get(inv.inviter_id)}
    {@const avatar = safeAvatarUrl(inviter?.avatar_url ?? null)}
    {@const inviterName = inviter?.display_name ?? inviter?.username ?? '…'}
    <div
      class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-2"
      data-testid="pending-community-row"
      data-invite-id={inv.id}
    >
      <Avatar.Root class="size-9 shrink-0">
        {#if avatar}
          <Avatar.Image src={avatar} alt="" />
        {/if}
        <Avatar.Fallback class="accent-gradient text-primary-foreground text-sm font-semibold">
          {inviterName.slice(0, 1).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <p class="text-text-bright truncate text-sm font-semibold">{inv.target_guild_name}</p>
        <p class="text-text-muted truncate text-xs">
          {m.pending_community_invites_from({ name: inviterName })}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => join(inv.id)}
        disabled={joiningId === inv.id}
        data-testid="pending-community-join-btn"
        title={m.pending_community_invites_accept_title()}
      >
        {#if joiningId === inv.id}
          <span class="text-xs">{m.pending_community_invites_joining()}</span>
        {:else}
          <CheckIcon class="size-4 text-emerald-400" />
        {/if}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => decline(inv.id)}
        disabled={joiningId === inv.id}
        data-testid="pending-community-decline-btn"
        title={m.pending_community_invites_decline_title()}
      >
        <XIcon class="size-4 text-rose-400" />
      </Button>
    </div>
  {/each}
</section>

<SelfHostContactConfirmDialog
  open={confirmOpen}
  hostname={confirmHost}
  onConfirm={onConfirmContact}
  onCancel={onCancelContact}
/>
