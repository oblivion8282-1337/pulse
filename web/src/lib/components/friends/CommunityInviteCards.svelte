<!--
  Empfängerseite der Nutzername-Einladungen: "<Name> lädt dich in <Community>
  ein" mit Annehmen/Ablehnen — gerendert im Pending-Tab der Freunde-Seite,
  direkt neben den Freundschaftsanfragen (gleiche Schiene). Annehmen legt die
  Membership an und navigiert in die Community.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Button } from '$lib/components/ui/button/index.js';
  import CheckIcon from '@lucide/svelte/icons/check';
  import XIcon from '@lucide/svelte/icons/x';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { toast } from 'svelte-sonner';
  import { communityInvites } from '$lib/stores/communityInvites.svelte';
  import { communityInvitesApi } from '$lib/api/communityInvites';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m } from '$lib/paraglide/messages.js';

  $effect(() => {
    for (const inv of communityInvites.list) userCache.queue(inv.inviter_user_id);
  });

  async function accept(id: string) {
    try {
      const res = await communityInvitesApi.accept(id);
      communityInvites.remove(id);
      // Frisch beigetretene Community sofort laden + hinein navigieren.
      await guilds.hydrate();
      await goto(
        res.channel_id
          ? `/app/guilds/${res.guild.id}/channels/${res.channel_id}`
          : `/app/guilds/${res.guild.id}/channels/_`
      );
    } catch (e) {
      // 404 = Einladung/Community inzwischen weg → Karte aufräumen.
      if ((e as { status?: number })?.status === 404) communityInvites.remove(id);
      toast.error(m.community_invite_accept_error(), {
        description: e instanceof Error ? e.message : undefined
      });
    }
  }

  async function decline(id: string) {
    try {
      await communityInvitesApi.decline(id);
      communityInvites.remove(id);
    } catch (e) {
      if ((e as { status?: number })?.status === 404) communityInvites.remove(id);
      else toast.error(m.community_invite_decline_error());
    }
  }
</script>

{#if communityInvites.list.length > 0}
  <div>
    <h2 class="text-text-bright px-1 pb-2 text-xs font-semibold uppercase tracking-wide">
      {m.community_invites_heading({ count: communityInvites.list.length })}
    </h2>
    {#each communityInvites.list as inv (inv.id)}
      {@const u = userCache.get(inv.inviter_user_id)}
      {@const avatar = safeAvatarUrl(u?.avatar_url ?? null)}
      <div
        class="hover:bg-bg-hover flex items-center gap-3 rounded-lg px-2 py-2"
        data-testid="community-invite-row"
        data-invite-id={inv.id}
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
          <p class="text-text-muted truncate text-xs">
            {m.community_invite_row_body({ guild: inv.guild_name })}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => accept(inv.id)}
          data-testid="community-invite-accept"
          title={m.community_invite_accept_title()}
        >
          <CheckIcon class="size-4 text-emerald-400" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => decline(inv.id)}
          data-testid="community-invite-decline"
          title={m.community_invite_decline_title()}
        >
          <XIcon class="size-4 text-rose-400" />
        </Button>
      </div>
    {/each}
  </div>
{/if}
