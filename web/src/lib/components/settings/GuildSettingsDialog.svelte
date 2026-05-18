<!--
  Modal-Server-Settings (Discord-Style).

  Two tabs in the side rail: Rollen (incl. member-assignment) and
  Eigentümerschaft. Visibility is gated server-side, mirrored here as
  the dialog hides what the caller can't use. The dialog is the
  primary UI entry; the previous standalone /settings page is gone —
  deep-linking wasn't a real use case.

  Channel-permissions stays a separate page for now because there's
  no in-line channel-settings dialog to host it.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import UsersIcon from '@lucide/svelte/icons/users';
  import CrownIcon from '@lucide/svelte/icons/crown';
  import { onMount } from 'svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { rolesApi } from '$lib/api/roles';
  import type { Guild } from '$lib/api/types';
  import RolesEditor from './RolesEditor.svelte';
  import MemberRoleAssignment from './MemberRoleAssignment.svelte';
  import OwnerTransferSection from './OwnerTransferSection.svelte';

  let {
    open = $bindable(false),
    guild
  }: {
    open?: boolean;
    /** Guild to open the dialog for. Required when ``open`` flips true;
     * may be null/undefined while the dialog is closed. */
    guild: Guild | null;
  } = $props();

  type Tab = 'roles' | 'members' | 'ownership';
  let tab = $state<Tab>('roles');

  let guildId = $derived(guild?.id ?? '');
  let canManageRoles = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_ROLES)
  );
  let isOwner = $derived(!!guild && auth.user?.id === guild.owner_id);
  let myPermissions = $derived(
    guildId ? roles.myGuildPerms[guildId] ?? '0' : '0'
  );

  // Default to the first tab the caller is allowed to see, so the
  // dialog never opens on a tab that's empty.
  $effect(() => {
    if (!open) return;
    if (canManageRoles) tab = 'roles';
    else if (isOwner) tab = 'ownership';
  });

  // Lazy-load roles when the dialog first opens for a guild whose roles
  // aren't in the store yet (rare — happens for freshly-joined guilds).
  onMount(() => {
    if (open && guildId && !roles.byGuild[guildId]?.length) {
      void rolesApi
        .list(guildId)
        .then((rows) => {
          for (const r of rows) roles.upsertRole(r);
        })
        .catch(() => undefined);
    }
  });

  function selectTab(t: Tab): void {
    tab = t;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="flex h-[80vh] max-h-[700px] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
    data-testid="guild-settings-dialog"
  >
    <Dialog.Header class="border-border border-b px-6 py-4">
      <Dialog.Title>{guild?.name ?? '…'} · Einstellungen</Dialog.Title>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1">
      <nav class="border-border w-48 shrink-0 border-r bg-bg-input/40 p-2">
        {#if canManageRoles}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'roles'}
            onclick={() => selectTab('roles')}
            data-testid="settings-tab-roles"
          >
            <ShieldIcon class="size-4" /> Rollen
          </button>
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'members'}
            onclick={() => selectTab('members')}
            data-testid="settings-tab-members"
          >
            <UsersIcon class="size-4" /> Mitglieder
          </button>
        {/if}
        {#if isOwner}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'ownership'}
            onclick={() => selectTab('ownership')}
            data-testid="settings-tab-ownership"
          >
            <CrownIcon class="size-4" /> Eigentümerschaft
          </button>
        {/if}
      </nav>

      <main class="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {#if !guild}
          <p class="text-text-muted text-sm">Server nicht gefunden.</p>
        {:else if tab === 'roles' && canManageRoles}
          <RolesEditor {guildId} editorPermissions={myPermissions} />
        {:else if tab === 'members' && canManageRoles}
          <MemberRoleAssignment {guildId} editorPermissions={myPermissions} />
        {:else if tab === 'ownership' && isOwner}
          <OwnerTransferSection {guild} />
        {:else}
          <p class="text-text-muted text-sm">
            Für diese Sektion fehlt dir eine Berechtigung.
          </p>
        {/if}
      </main>
    </div>
  </Dialog.Content>
</Dialog.Root>
