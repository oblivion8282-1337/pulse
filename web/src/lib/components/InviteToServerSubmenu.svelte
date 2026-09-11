<!--
  Submenu rendered inside PopoverFriendActions when the user clicks
  "Zu Server einladen". Lists all guilds where the caller has CREATE_INVITES
  permission — AUSSER solche, in denen der Freund bereits Mitglied ist
  (2026-09-11: ein Angebot, das der Server ohnehin mit 409 already_member
  quittiert, verwirrt nur). Clicking one sends a Community-Invite (Stufe 3)
  statt einem Roh-Link per DM.

  Flow:
    1. chatApi.createInvite(guild.id, {maxUses:1, expiresInSeconds:86400})
       → host-Invite-Code auf dem Ziel-Server
    2. communityInvitesApi.create({...}) → Cloud-Broker
-->
<script lang="ts">
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { chatApi } from '$lib/api/chat';
  import { communityInvitesApi } from '$lib/api/community-invites';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { toast } from 'svelte-sonner';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';
  import { guildIconSrc } from '$lib/guildIcon';
  import { memberListCache } from './MentionAutocomplete.svelte';

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

  // Communitys, in denen der Freund schon Mitglied ist — sie verschwinden
  // aus der Liste. memberListCache teilt sich den Fetch mit MemberList/
  // Mention-Autocomplete (ein Call je Guild, deduped, bei Mitglieds-
  // wechseln invalidiert). Ein Cache-Fehler lässt die Community sichtbar:
  // der Backend-Guard (409 already_member) fängt den Restfall auf.
  let friendGuildIds = $state<Set<string>>(new Set());

  $effect(() => {
    const ziele = invitableGuilds;
    if (ziele.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(
      ziele.map(async (g) =>
        (await memberListCache.get(g.id)).some((mitglied) => mitglied.user_id === friendUserId)
          ? g.id
          : null
      )
    ).then((ergebnisse) => {
      if (cancelled) return;
      friendGuildIds = new Set(
        ergebnisse.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null).map((r) => r.value)
      );
    });
    return () => {
      cancelled = true;
    };
  });

  let anbietbareGuilds = $derived(invitableGuilds.filter((g) => !friendGuildIds.has(g.id)));

  function guildInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  async function sendInvite(guild: Guild) {
    if (working) return;
    working = true;
    try {
      // 1. Frischen host-Invite-Code minten (single-use, 24h)
      const invite = await chatApi.createInvite(guild.id, {
        maxUses: 1,
        expiresInSeconds: 86400
      });
      // 2. Community-Invite über den Cloud-Broker schicken
      const srv = activeServer.current;
      if (!srv?.hostname) {
        // Ohne aktiven Server-Host fehlt dem Broker der Routing-Key
        // (Backend verlangt target_host non-empty → sonst 422). Früh + klar
        // abbrechen statt einen leeren String zu senden.
        toast.error(m.invite_to_server_submenu_invite_error());
        return;
      }
      await communityInvitesApi.create({
        invitee_id: friendUserId,
        target_host: srv.hostname,
        target_instance_id: srv.instance_id ?? null,
        target_guild_id: guild.id,
        target_guild_name: guild.name,
        code: invite.code
      });
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
  {#if anbietbareGuilds.length === 0}
    <p class="text-text-muted px-3 py-2 text-xs">
      {m.invite_to_server_submenu_no_invitable_guilds()}
    </p>
  {:else}
    {#each anbietbareGuilds as guild (guild.id)}
      {@const iconSrc = guildIconSrc(guild.icon_url, activeServer.current?.hostname)}
      <MenuRow
        onclick={() => sendInvite(guild)}
        disabled={working}
        data-testid="invite-guild-btn"
      >
        <Avatar.Root class="size-6 shrink-0">
          {#if iconSrc}
            <Avatar.Image src={iconSrc} alt={guild.name} />
          {/if}
          <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
            {guildInitial(guild.name)}
          </Avatar.Fallback>
        </Avatar.Root>
        <span class="truncate">{guild.name}</span>
      </MenuRow>
    {/each}
  {/if}
</div>
