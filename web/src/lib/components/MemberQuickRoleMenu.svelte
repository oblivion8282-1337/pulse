<!--
  ContextMenu items for quickly toggling a member's roles.

  Lives inside whatever ContextMenu.Root the caller already has — this
  component renders only Items + a Sub menu, no wrapping Root/Trigger.
  That lets the host (MemberList row) layer it under existing
  ``UserProfilePopover`` clicks: left-click opens the profile, right-
  click pops this menu.

  Visibility: hidden entirely when the caller lacks MANAGE_ROLES.
  Anti-escalation: each checkbox locks when the role grants bits the
  editor doesn't hold (ADMINISTRATOR being the common one).
-->
<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import { toast } from 'svelte-sonner';
  import { rolesApi, type Role } from '$lib/api/roles';
  import { m } from '$lib/paraglide/messages.js';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import { memberRoles } from '$lib/stores/memberRoles.svelte';
  import { Perm, has, toBitfield } from '$lib/permissions/bitfield';

  let { guildId, userId }: { guildId: string; userId: string } = $props();

  // Hidden when the caller can't actually do anything useful here.
  let canManage = $derived(rolesStore.hasGuildPermission(guildId, Perm.MANAGE_ROLES));
  let editorPerms = $derived(rolesStore.myGuildPerms[guildId] ?? '0');
  let assignable = $derived(
    (rolesStore.byGuild[guildId] ?? [])
      .filter((r) => !r.is_everyone)
      .sort((a, b) => b.position - a.position)
  );
  let memberIds = $derived(new Set(memberRoles.for(guildId, userId)));

  function locked(role: Role): boolean {
    const rp = toBitfield(role.permissions);
    const ep = toBitfield(editorPerms);
    return (rp & ~ep) !== 0n;
  }

  async function toggle(role: Role, on: boolean): Promise<void> {
    // Optimistic: write into the cache so the menu reflects the change
    // before the API round-trip. WS event will sync other clients;
    // ours just won't double-toggle.
    const existing = memberRoles.for(guildId, userId);
    const nextIds = on
      ? [...existing, role.id]
      : existing.filter((id) => id !== role.id);
    memberRoles.seedAll(guildId, { [userId]: nextIds }, [userId]);
    try {
      if (on) await rolesApi.assign(guildId, userId, role.id);
      else await rolesApi.unassign(guildId, userId, role.id);
    } catch (err) {
      memberRoles.seedAll(guildId, { [userId]: existing }, [userId]);
      toast.error(m.member_quick_role_menu_toggle_failed(), {
        description: (err as Error).message
      });
    }
  }

  // Lazy per-member role cache is primed by the host's
  // `oncontextmenu` handler before the menu opens — see MemberList.
</script>

{#if canManage && assignable.length > 0}
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger>
      <ShieldIcon />
      {m.member_quick_role_menu_manage_roles()}
    </ContextMenu.SubTrigger>
    <ContextMenu.SubContent>
      {#each assignable as r (r.id)}
        {@const checked = memberIds.has(r.id)}
        {@const disabled = locked(r)}
        <ContextMenu.CheckboxItem
          {checked}
          {disabled}
          onCheckedChange={(v) => toggle(r, v)}
          data-testid={`member-${userId}-role-${r.id}`}
        >
          <span style={r.color ? `color: #${r.color.toString(16).padStart(6, '0')}` : ''}>
            {r.name}
          </span>
        </ContextMenu.CheckboxItem>
      {/each}
    </ContextMenu.SubContent>
  </ContextMenu.Sub>
{/if}
