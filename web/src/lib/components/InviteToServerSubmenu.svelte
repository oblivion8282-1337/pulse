<!--
  Submenu rendered inside PopoverFriendActions when the user clicks
  "Zu Server einladen". Lists all guilds where the caller has CREATE_INVITES
  permission; clicking one sends a single-use 24h invite to the friend via DM.
-->
<script lang="ts">
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { chatApi } from '$lib/api/chat';
  import { buildInviteLink } from '$lib/guilds/inviteLink';
  import { toast } from 'svelte-sonner';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    friendUserId,
    friendName,
    onDone
  }: {
    friendUserId: string;
    friendName: string;
    onDone: () => void;
  } = $props();

  let working = $state(false);

  let invitableGuilds = $derived(
    guilds.list.filter((g: Guild) => roles.hasGuildPermission(g.id, Perm.CREATE_INVITES))
  );

  function guildInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  async function sendInvite(guild: Guild) {
    if (working) return;
    working = true;
    try {
      const invite = await chatApi.createInvite(guild.id, {
        maxUses: 1,
        expiresInSeconds: 86400
      });
      const dm = await chatApi.createOrGetDMChannel(friendUserId);
      const link = buildInviteLink(invite.code);
      await chatApi.postMessage(dm.id, link);
      toast.success(m.invite_to_server_submenu_invite_sent({ friendName }));
      onDone();
    } catch (e) {
      toast.error(m.invite_to_server_submenu_invite_error(), {
        description: (e as Error).message
      });
    } finally {
      working = false;
    }
  }
</script>

<div class="mt-1 flex flex-col gap-1" data-testid="invite-to-server-submenu">
  {#if invitableGuilds.length === 0}
    <p class="text-text-muted px-3 py-2 text-xs">
      {m.invite_to_server_submenu_no_invitable_guilds()}
    </p>
  {:else}
    {#each invitableGuilds as guild (guild.id)}
      <button
        type="button"
        class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-bg-hover hover:text-primary text-text-base disabled:opacity-50"
        onclick={() => sendInvite(guild)}
        disabled={working}
        data-testid="invite-guild-btn"
      >
        <Avatar.Root class="size-6 shrink-0">
          {#if guild.icon_url}
            <Avatar.Image src={guild.icon_url} alt={guild.name} />
          {/if}
          <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
            {guildInitial(guild.name)}
          </Avatar.Fallback>
        </Avatar.Root>
        <span class="truncate">{guild.name}</span>
      </button>
    {/each}
  {/if}
</div>
