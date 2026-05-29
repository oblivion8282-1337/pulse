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
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import UsersIcon from '@lucide/svelte/icons/users';
  import CrownIcon from '@lucide/svelte/icons/crown';
  import BanIcon from '@lucide/svelte/icons/ban';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import PuzzleIcon from '@lucide/svelte/icons/puzzle';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
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
  import BansList from './BansList.svelte';
  import GuildSoundsEditor from './GuildSoundsEditor.svelte';
  import GuildPluginsEditor from './GuildPluginsEditor.svelte';
  import ModQueue from '$lib/components/admin/ModQueue.svelte';
  import AuditLogViewer from '$lib/components/admin/AuditLogViewer.svelte';

  let {
    open = $bindable(false),
    guild
  }: {
    open?: boolean;
    /** Guild to open the dialog for. Required when ``open`` flips true;
     * may be null/undefined while the dialog is closed. */
    guild: Guild | null;
  } = $props();

  type Tab = 'roles' | 'members' | 'bans' | 'sounds' | 'plugins' | 'modqueue' | 'auditlog' | 'ownership';
  let tab = $state<Tab>('roles');

  let guildId = $derived(guild?.id ?? '');
  let canManageRoles = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_ROLES)
  );
  let isOwner = $derived(!!guild && auth.user?.id === guild.owner_id);
  let myPermissions = $derived(
    guildId ? roles.myGuildPerms[guildId] ?? '0' : '0'
  );
  let canBanMembers = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.BAN_MEMBERS)
  );
  // Sound-overrides reuse MANAGE_GUILD on the backend (server-rename /
  // icon / settings sit on the same bit). Matches Discord's "manage
  // server" grouping.
  let canManageSounds = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_GUILD)
  );
  // Plugin-Toggles benutzen denselben MANAGE_GUILD-Bit wie Sounds —
  // semantisch passt das (alles "Server konfigurieren"). Das Backend
  // gated GET/PUT /guilds/{id}/plugins ebenfalls auf MANAGE_GUILD.
  let canManagePlugins = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_GUILD)
  );
  // Mod-Queue: sichtbar wenn MANAGE_MESSAGES | BAN_MEMBERS | MANAGE_GUILD.
  let canSeeModQueue = $derived(
    !!guildId &&
      (roles.hasGuildPermission(guildId, Perm.MANAGE_MESSAGES) ||
        roles.hasGuildPermission(guildId, Perm.BAN_MEMBERS) ||
        roles.hasGuildPermission(guildId, Perm.MANAGE_GUILD))
  );
  // Audit-Log: nur MANAGE_GUILD.
  let canSeeAuditLog = $derived(
    !!guildId && roles.hasGuildPermission(guildId, Perm.MANAGE_GUILD)
  );

  // Default to the first tab the caller is allowed to see, so the
  // dialog never opens on a tab that's empty.
  $effect(() => {
    if (!open) return;
    if (canManageRoles) tab = 'roles';
    else if (canBanMembers) tab = 'bans';
    else if (canManageSounds) tab = 'sounds';
    else if (canManagePlugins) tab = 'plugins';
    else if (canSeeModQueue) tab = 'modqueue';
    else if (isOwner) tab = 'ownership';
  });

  // Dirty-flag from RolesEditor — true while there are unsaved
  // changes in the buffer. Used to gate the close + tab-switch.
  let rolesEditorDirty = $state(false);
  let closeConfirmOpen = $state(false);
  let tabConfirmOpen = $state(false);
  let pendingTab = $state<Tab | null>(null);
  // One-shot override so the user-confirmed discard close passes
  // through the dirty guard instead of bouncing back.
  let closeOverride = $state(false);
  // Monotonic signal — bumping it tells RolesEditor to reset its
  // local edit buffer. Without this, just resetting `rolesEditorDirty`
  // here would be reverted on the next tick because the editor's
  // dirty-effect compares buffer ≠ persisted role and flips it back.
  let discardSignal = $state(0);

  function handleOpenChange(next: boolean): void {
    if (!next && rolesEditorDirty && !closeOverride) {
      // bits-ui already set its internal state to closed and the
      // bind:open below is in the middle of propagating that to us.
      // Schedule the reopen for after that propagation so our true
      // isn't immediately overwritten by the same-tick false.
      closeConfirmOpen = true;
      queueMicrotask(() => {
        open = true;
      });
      return;
    }
    if (!next) {
      // Either nothing dirty, or the user just confirmed discard —
      // reset the one-shot so the next open starts fresh.
      closeOverride = false;
    }
  }

  function confirmDiscardClose(): void {
    closeConfirmOpen = false;
    closeOverride = true;
    // Drop the buffer too — Dialog.Root keeps the inner content mounted
    // through its close transition, so leaving a dirty buffer behind
    // would briefly flash "ungespeicherte Änderungen" before unmount.
    discardSignal += 1;
    open = false;
  }

  // beforeunload guard so a hard tab-close also asks. Browsers ignore
  // our custom message — they show their own generic prompt — but the
  // event being present at all is what triggers the dialog.
  $effect(() => {
    if (typeof window === 'undefined') return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (open && rolesEditorDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
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
    if (t === tab) return;
    if (rolesEditorDirty && tab === 'roles') {
      pendingTab = t;
      tabConfirmOpen = true;
      return;
    }
    tab = t;
  }

  function confirmDiscardTab(): void {
    // Signal RolesEditor to roll back its buffer. The editor's dirty
    // effect will then flip `rolesEditorDirty` to false on its own —
    // clearing it manually here would race with the next reactive run.
    discardSignal += 1;
    if (pendingTab) {
      tab = pendingTab;
      pendingTab = null;
    }
    tabConfirmOpen = false;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
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
        {#if canBanMembers}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'bans'}
            onclick={() => selectTab('bans')}
            data-testid="settings-tab-bans"
          >
            <BanIcon class="size-4" /> Sperrungen
          </button>
        {/if}
        {#if canManageSounds}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'sounds'}
            onclick={() => selectTab('sounds')}
            data-testid="settings-tab-sounds"
          >
            <Volume2Icon class="size-4" /> Sounds
          </button>
        {/if}
        {#if canManagePlugins}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'plugins'}
            onclick={() => selectTab('plugins')}
            data-testid="settings-tab-plugins"
          >
            <PuzzleIcon class="size-4" /> Plugins
          </button>
        {/if}
        {#if canSeeModQueue}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'modqueue'}
            onclick={() => selectTab('modqueue')}
            data-testid="settings-tab-modqueue"
          >
            <FlagIcon class="size-4" /> Mod-Queue
          </button>
        {/if}
        {#if canSeeAuditLog}
          <button
            type="button"
            class="hover:bg-bg-hover mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
            class:bg-bg-hover={tab === 'auditlog'}
            onclick={() => selectTab('auditlog')}
            data-testid="settings-tab-auditlog"
          >
            <ScrollTextIcon class="size-4" /> Audit-Log
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
          <p class="text-text-muted text-sm">Community nicht gefunden.</p>
        {:else if tab === 'roles' && canManageRoles}
          <RolesEditor
            {guildId}
            editorPermissions={myPermissions}
            {discardSignal}
            bind:dirty={rolesEditorDirty}
          />
        {:else if tab === 'members' && canManageRoles}
          <MemberRoleAssignment {guildId} editorPermissions={myPermissions} />
        {:else if tab === 'bans' && canBanMembers}
          <BansList {guildId} />
        {:else if tab === 'sounds' && canManageSounds}
          <GuildSoundsEditor {guildId} />
        {:else if tab === 'plugins' && canManagePlugins}
          <GuildPluginsEditor {guildId} />
        {:else if tab === 'modqueue' && canSeeModQueue}
          <ModQueue {guildId} />
        {:else if tab === 'auditlog' && canSeeAuditLog}
          <AuditLogViewer {guildId} />
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

<AlertDialog.Root bind:open={closeConfirmOpen}>
  <AlertDialog.Content data-testid="settings-close-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>Ungespeicherte Änderungen verwerfen?</AlertDialog.Title>
      <AlertDialog.Description>
        Du hast Änderungen an einer Rolle, die noch nicht gespeichert sind.
        Beim Schließen der Einstellungen gehen sie verloren.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Weiter bearbeiten</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDiscardClose}>Verwerfen</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={tabConfirmOpen}>
  <AlertDialog.Content data-testid="settings-tab-switch-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>Ungespeicherte Änderungen verwerfen?</AlertDialog.Title>
      <AlertDialog.Description>
        Beim Wechsel des Tabs gehen die ungespeicherten Änderungen verloren.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Weiter bearbeiten</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDiscardTab}>Verwerfen</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
