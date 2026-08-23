<!--
  ContextMenu items for quickly toggling a member's roles.

  Renders only a Sub menu (plus its CheckboxItems) — no wrapping
  Root/Trigger — so the host drops it straight into an existing
  ContextMenu.Content. Currently the sole caller is
  ``UserProfilePopover``'s ``extra`` snippet (right-click member row →
  popover → "Rollen verwalten"). ``MemberListItem`` gates the whole
  snippet on ``canQuickRole`` so the Sub only mounts when editable.

  Visibility: hidden entirely when the caller lacks MANAGE_ROLES.
  Anti-escalation: each checkbox locks when the role grants bits the
  editor doesn't hold (ADMINISTRATOR being the common one).
-->
<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { toast } from 'svelte-sonner';
  import { rolesApi, type Role } from '$lib/api/roles';
  import { m } from '$lib/paraglide/messages.js';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import { memberRoles } from '$lib/stores/memberRoles.svelte';
  import { Perm, has, toBitfield } from '$lib/permissions/bitfield';

  let {
    guildId,
    userId,
    flach = false
  }: {
    guildId: string;
    userId: string;
    /**
     * Flache Liste statt Untermenue.
     *
     * Der Normalfall ist ein `ContextMenu.Sub` — der setzt aber ein
     * `ContextMenu.Root` darum voraus. Auf dem Handy ist das Profil ein Blatt
     * von unten und KEIN Kontextmenue (es gibt dort keinen Rechtsklick); ein
     * Untermenue rendert darin nichts. Ausserdem waere eine aufklappende
     * zweite Ebene in einem Blatt die falsche Geste.
     */
    flach?: boolean;
  } = $props();

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

  // Prime the lazy per-member role cache as soon as this sub-menu mounts
  // (i.e. once the right-click profile menu opens and the caller can
  // manage roles), so the checkboxes reflect the correct state at first
  // render instead of flashing empty.
  $effect(() => {
    void memberRoles.ensure(guildId, userId).catch(() => undefined);
  });
</script>

{#if canManage && assignable.length > 0}
  {#if flach}
    <div class="mt-3" data-testid="member-role-list">
      <div class="text-text-muted flex items-center gap-1.5 px-1 pb-1 text-xs font-semibold">
        <ShieldIcon class="size-3.5" />
        {m.member_quick_role_menu_manage_roles()}
      </div>
      {#each assignable as r (r.id)}
        {@const checked = memberIds.has(r.id)}
        {@const disabled = locked(r)}
        <button
          type="button"
          class="hover:bg-bg-hover flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm disabled:opacity-40"
          {disabled}
          onclick={() => toggle(r, !checked)}
          data-testid={`member-${userId}-role-${r.id}`}
          aria-pressed={checked}
        >
          <span
            class="border-border flex size-5 shrink-0 items-center justify-center rounded border {checked
              ? 'bg-primary border-primary text-white'
              : ''}"
          >
            {#if checked}<CheckIcon class="size-3.5" />{/if}
          </span>
          <span
            class="truncate"
            style={r.color ? `color: #${r.color.toString(16).padStart(6, '0')}` : ''}
          >{r.name}</span>
        </button>
      {/each}
    </div>
  {:else}
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
{/if}
