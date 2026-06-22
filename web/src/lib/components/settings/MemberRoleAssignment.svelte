<!--
  Per-member role-assignment grid.

  Loads the guild's member list once + each member's role-ids lazily on
  selection. Backend enforces MANAGE_ROLES + anti-escalation (you can't
  hand someone a role with bits you don't have). The UI mirrors that
  with a disabled toggle when the editor lacks the role's permissions
  or the role has ADMINISTRATOR.

  No realtime member_roles broadcasts for *other* users — the server
  emits a hint without the new role list, so peers refresh only when
  the change targets themselves. Within a single open editor session
  we keep the optimistic state until the API confirms.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SearchIcon from '@lucide/svelte/icons/search';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { chatApi } from '$lib/api/chat';
  import { rolesApi, type Role } from '$lib/api/roles';
  import { roles as rolesStore } from '$lib/stores/roles.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { Perm, has, toBitfield } from '$lib/permissions/bitfield';
  import type { Member } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  function displayName(m: Member): string {
    return m.nickname ?? userCache.displayName(m.user_id);
  }

  let { guildId, editorPermissions }: { guildId: string; editorPermissions: string } = $props();

  let members = $state<Member[]>([]);
  let loading = $state(true);
  let filter = $state('');
  let selectedUserId = $state<string | null>(null);
  // user_id → role_ids the member holds (excluding @everyone — implicit).
  let memberRoleIds = $state<Record<string, Set<string>>>({});
  let busy = $state<Set<string>>(new Set());

  // We mostly care about the non-@everyone roles for the toggle grid.
  let assignableRoles = $derived(
    (rolesStore.byGuild[guildId] ?? [])
      .filter((r) => !r.is_everyone)
      .sort((a, b) => b.position - a.position)
  );

  let filteredMembers = $derived(
    !filter.trim()
      ? members
      : members.filter((mbr) => {
          const needle = filter.trim().toLowerCase();
          return (mbr.nickname ?? '').toLowerCase().includes(needle)
            || userCache.displayName(mbr.user_id).toLowerCase().includes(needle)
            || mbr.user_id.includes(needle);
        })
  );

  onMount(async () => {
    try {
      members = await chatApi.listMembers(guildId);
      // Queue username lookups so display_name resolves to a human-
      // readable value rather than the raw snowflake id.
      for (const mbr of members) userCache.queue(mbr.user_id);
    } catch (err) {
      toast.error(m.member_role_assignment_load_members_failed(), { description: (err as Error).message });
    } finally {
      loading = false;
    }
  });

  async function selectMember(userId: string): Promise<void> {
    selectedUserId = userId;
    if (memberRoleIds[userId]) return;
    try {
      const rows = await rolesApi.listMemberRoles(guildId, userId);
      memberRoleIds = {
        ...memberRoleIds,
        [userId]: new Set(rows.filter((r) => !r.is_everyone).map((r) => r.id))
      };
    } catch (err) {
      toast.error(m.member_role_assignment_load_member_roles_failed(), {
        description: (err as Error).message
      });
    }
  }

  /** Resolved disabled state for one (member, role) toggle. */
  function locked(role: Role): { locked: boolean; reason: string | null } {
    // Anti-escalation mirror: the editor must hold every bit the role
    // grants. ADMINISTRATOR is the most common trap.
    const rolePerm = toBitfield(role.permissions);
    const editorPerm = toBitfield(editorPermissions);
    const missing = rolePerm & ~editorPerm;
    if (missing !== 0n) {
      if (has(rolePerm, Perm.ADMINISTRATOR) && !has(editorPerm, Perm.ADMINISTRATOR)) {
        return { locked: true, reason: m.member_role_assignment_locked_admin() };
      }
      return { locked: true, reason: m.member_role_assignment_locked_missing_bits() };
    }
    return { locked: false, reason: null };
  }

  async function toggle(userId: string, role: Role, on: boolean): Promise<void> {
    const key = `${userId}:${role.id}`;
    if (busy.has(key)) return;
    busy = new Set([...busy, key]);
    // Optimistic update so the checkbox doesn't flicker.
    const existing = memberRoleIds[userId] ?? new Set<string>();
    const next = new Set(existing);
    on ? next.add(role.id) : next.delete(role.id);
    memberRoleIds = { ...memberRoleIds, [userId]: next };
    try {
      if (on) {
        await rolesApi.assign(guildId, userId, role.id);
      } else {
        await rolesApi.unassign(guildId, userId, role.id);
      }
    } catch (err) {
      // Nur DIESEN Toggle gegen die AKTUELLE Menge zurückrollen — NICHT auf den
      // (vor diesem Toggle gemachten) `existing`-Snapshot zurücksetzen: ein
      // paralleler Toggle einer ANDEREN Rolle desselben Users (busy ist pro
      // (userId,roleId)) würde sonst verworfen. Server-403 (z.B. Hierarchie-
      // Verstoß) macht diesen Pfad realistisch.
      const rollback = new Set(memberRoleIds[userId] ?? existing);
      on ? rollback.delete(role.id) : rollback.add(role.id);
      memberRoleIds = { ...memberRoleIds, [userId]: rollback };
      toast.error(m.member_role_assignment_toggle_failed(), { description: (err as Error).message });
    } finally {
      const nextBusy = new Set(busy);
      nextBusy.delete(key);
      busy = nextBusy;
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-4 md:flex-row" data-testid="member-role-assignment">
  <aside class="w-full shrink-0 md:w-72">
    <div class="mb-2 flex items-center gap-2">
      <SearchIcon class="text-text-muted size-4" />
      <Input
        bind:value={filter}
        placeholder={m.member_role_assignment_search_placeholder()}
        class="h-8 text-sm"
        data-testid="member-filter"
      />
    </div>
    {#if loading}
      <p class="text-text-muted text-sm">{m.member_role_assignment_loading()}</p>
    {:else}
      <ul class="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
        {#each filteredMembers as mbr (mbr.user_id)}
          <li>
            <button
              type="button"
              class="hover:bg-bg-hover w-full rounded-lg px-3 py-2 text-left text-sm transition-colors"
              class:bg-bg-hover={selectedUserId === mbr.user_id}
              onclick={() => selectMember(mbr.user_id)}
              data-testid={`member-row-${mbr.user_id}`}
            >
              <div class="text-text-bright truncate font-medium">
                {displayName(mbr)}
              </div>
              <div class="text-text-muted truncate text-xs">{mbr.user_id}</div>
            </button>
          </li>
        {/each}
        {#if filteredMembers.length === 0}
          <li class="text-text-muted px-3 py-2 text-sm">{m.member_role_assignment_no_results()}</li>
        {/if}
      </ul>
    {/if}
  </aside>

  <section class="min-w-0 flex-1 overflow-y-auto">
    {#if !selectedUserId}
      <p class="text-text-muted text-sm">{m.member_role_assignment_select_member_hint()}</p>
    {:else if !memberRoleIds[selectedUserId]}
      <p class="text-text-muted text-sm">{m.member_role_assignment_loading_roles()}</p>
    {:else if assignableRoles.length === 0}
      <p class="text-text-muted text-sm">
        {m.member_role_assignment_no_assignable_roles()}
      </p>
    {:else}
      {@const selMember = members.find((mbr) => mbr.user_id === selectedUserId)}
      <header class="mb-3">
        <h3 class="text-text-bright text-sm font-semibold">
          {m.member_role_assignment_roles_for({ name: selMember ? displayName(selMember) : (selectedUserId ?? '') })}
        </h3>
        <p class="text-text-muted text-xs">
          {m.member_role_assignment_position_hint()}
        </p>
      </header>
      <ul class="divide-border divide-y">
        {#each assignableRoles as r (r.id)}
          {@const lock = locked(r)}
          {@const checked = memberRoleIds[selectedUserId]!.has(r.id)}
          {@const key = `${selectedUserId}:${r.id}`}
          <li class="flex items-center justify-between py-2">
            <div class="min-w-0">
              <div class="text-text-bright text-sm font-medium" style={r.color ? `color: #${r.color.toString(16).padStart(6, '0')}` : ''}>
                {r.name}
              </div>
              <div class="text-text-muted text-xs">{m.member_role_assignment_position({ position: r.position })}</div>
              {#if lock.locked}
                <div class="text-xs text-amber-500">{lock.reason}</div>
              {/if}
            </div>
            <input
              type="checkbox"
              class="size-4 accent-primary"
              {checked}
              disabled={lock.locked || busy.has(key)}
              onchange={(ev) =>
                toggle(selectedUserId!, r, (ev.currentTarget as HTMLInputElement).checked)}
              data-testid={`assign-${selectedUserId}-${r.id}`}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
